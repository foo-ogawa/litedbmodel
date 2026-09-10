/**
 * @fileoverview Require the relation declaration form the project's DECORATOR PROTOCOL allows.
 * @description
 * A relation is a prototype getter. How a class field interacts with it differs by protocol:
 *
 *  - **legacy decorators** (`experimentalDecorators: true`): `declare posts: …` emits no field, so the
 *    getter is what the instance sees. `posts!: …` DOES emit a field under `useDefineForClassFields`
 *    and shadows the getter — silently, with `undefined` reads. That is what this rule catches.
 *  - **standard decorators** (TC39, the TypeScript 5 default): a decorated `declare` field is a
 *    COMPILE ERROR (TS1206), so `posts!: …` is the only spelling — and litedbmodel removes the
 *    shadowing field itself. Requiring `declare` there makes the project uncompilable, and the
 *    autofix used to do exactly that.
 *
 * The protocol is read from the TypeScript program when type-aware linting is on; otherwise set it
 * explicitly: `"litedbmodel/require-declare-for-relations": ["error", { "decorators": "standard" }]`.
 */

"use strict";

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: "problem",
    docs: {
      description: "Require 'declare' keyword for relation properties decorated with @hasMany, @belongsTo, or @hasOne",
      category: "Possible Errors",
      recommended: true,
    },
    fixable: "code",
    schema: [
      {
        type: "object",
        properties: {
          decorators: { enum: ["legacy", "standard", "auto"] },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      useDeclare:
        "Relation property '{{name}}' should use 'declare' instead of '!' assertion. " +
        "Under legacy decorators a class field with '!' shadows the prototype getter, so the relation " +
        "reads as undefined.",
      useDefinite:
        "Relation property '{{name}}' must use '!' instead of 'declare'. " +
        "Standard (TC39) decorators reject a decorated 'declare' field (TS1206); litedbmodel removes " +
        "the shadowing class field itself.",
    },
  },

  create(context) {
    const relationDecorators = new Set(["hasMany", "belongsTo", "hasOne"]);
    const sourceCode = context.getSourceCode();

    /**
     * Which decorator protocol this project compiles with. Read from the TypeScript program when
     * type-aware linting makes it available — guessing wrong turns this rule into an autofix that
     * breaks the build, so the answer comes from the compiler options, not from the source text.
     */
    function decoratorProtocol() {
      const configured = (context.options && context.options[0] && context.options[0].decorators) || "auto";
      if (configured !== "auto") return configured;
      const services = sourceCode.parserServices || context.parserServices;
      const program = services && services.program;
      if (program && typeof program.getCompilerOptions === "function") {
        return program.getCompilerOptions().experimentalDecorators ? "legacy" : "standard";
      }
      // No program to ask. `experimentalDecorators` is what this rule has always assumed, and it is
      // still the only protocol where `declare` is required.
      return "legacy";
    }

    const protocol = decoratorProtocol();

    /**
     * Check if a decorator is a relation decorator
     */
    function isRelationDecorator(decorator) {
      // Handle @hasMany(...) - CallExpression
      if (decorator.expression?.type === "CallExpression") {
        const callee = decorator.expression.callee;
        // Direct call: @hasMany(...)
        if (callee.type === "Identifier" && relationDecorators.has(callee.name)) {
          return true;
        }
      }
      // Handle @hasMany without parentheses (unlikely but possible)
      if (decorator.expression?.type === "Identifier") {
        return relationDecorators.has(decorator.expression.name);
      }
      return false;
    }

    /**
     * Check if property has relation decorator
     */
    function hasRelationDecorator(node) {
      const decorators = node.decorators || [];
      return decorators.some(isRelationDecorator);
    }

    /**
     * Get the relation decorator name for error message
     */
    function getRelationDecoratorName(node) {
      const decorators = node.decorators || [];
      for (const decorator of decorators) {
        if (decorator.expression?.type === "CallExpression") {
          const callee = decorator.expression.callee;
          if (callee.type === "Identifier" && relationDecorators.has(callee.name)) {
            return callee.name;
          }
        }
        if (decorator.expression?.type === "Identifier" && relationDecorators.has(decorator.expression.name)) {
          return decorator.expression.name;
        }
      }
      return null;
    }

    return {
      // Check PropertyDefinition (class fields) - TypeScript AST
      PropertyDefinition(node) {
        // Skip if no decorators or not a relation
        if (!hasRelationDecorator(node)) {
          return;
        }

        const propertyKeyName = node.key?.name || node.key?.value || "unknown";

        // Standard decorators: `declare` does not compile on a decorated field, so `!` is correct.
        if (protocol === "standard") {
          if (node.declare === true) {
            context.report({ node, messageId: "useDefinite", data: { name: propertyKeyName } });
          }
          return;
        }

        // Check if using definite assignment assertion (!)
        // In TypeScript ESLint AST, this is represented as `definite: true`
        if (node.definite === true) {
          const propertyName = node.key?.name || node.key?.value || "unknown";
          
          context.report({
            node,
            messageId: "useDeclare",
            data: {
              name: propertyName,
            },
            fix(fixer) {
              // Get the source text of the property
              const text = sourceCode.getText(node);
              
              // Find the property name and the ! after it
              // Pattern: propertyName!: Type
              const match = text.match(/^(\s*(?:@\w+\([^)]*\)\s*)*?)(\w+)(!)(:\s*.+)$/s);
              if (match) {
                // Replace propertyName!: with declare propertyName:
                const [, decorators, name, , typeAndRest] = match;
                const newText = `${decorators}declare ${name}${typeAndRest}`;
                return fixer.replaceText(node, newText);
              }
              
              // Alternative: just replace the node key area
              // Find the ! token after the property key
              const tokens = sourceCode.getTokens(node);
              for (let i = 0; i < tokens.length; i++) {
                const token = tokens[i];
                if (token.type === "Punctuator" && token.value === "!") {
                  // Find if there's a 'declare' keyword already
                  const hasDeclare = tokens.some(t => t.type === "Keyword" && t.value === "declare");
                  if (!hasDeclare) {
                    // Remove ! and add declare before property name
                    const keyToken = tokens.find(t => t.type === "Identifier" && t.value === propertyName);
                    if (keyToken) {
                      return [
                        fixer.insertTextBefore(keyToken, "declare "),
                        fixer.remove(token),
                      ];
                    }
                  }
                  break;
                }
              }
              
              return null;
            },
          });
        }
      },

      // Also check ClassProperty for older ESLint versions
      ClassProperty(node) {
        // Delegate to PropertyDefinition handler
        this.PropertyDefinition(node);
      },
    };
  },
};

