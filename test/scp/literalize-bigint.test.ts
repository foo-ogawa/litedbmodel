/**
 * Regression: a bc `int` value (a BigInt on the TS plane) used as a WRITE param.
 *
 * A read of an integer column returns bc's int model — a BigInt. Feeding that value into a later
 * write (the canonical case: the id from `create({returning:true})` passed to a nested `create`)
 * routes it through {@link literalize} into a transaction-plan param, which the tx runtime renders
 * through bc's `evaluateExpression`. bc accepts an integer only as a plain JS number (safe range) or
 * the `{int:"…"}` literal — a RAW BigInt node is rejected with `invalid node`. So `literalize` MUST
 * encode a BigInt as bc's canonical int literal, exactly as bc itself emits an out-of-safe-range int.
 *
 * The existing tx-DAG nested-write test did NOT cover this: its child INSERT keys off `$.ref.<parent>.id`
 * (a scope ref resolved inside the plan), never a consumer-supplied BigInt through `literalize`.
 */
import { describe, it, expect } from 'vitest';
import { evaluateExpression } from 'behavior-contracts/runtime';
import { literalize } from '../../src/scp/makesql/tx';

describe('literalize — a bc int (BigInt) write param', () => {
  it('encodes a BigInt as bc\'s canonical {int:"…"} literal', () => {
    expect(literalize(1027n)).toEqual({ int: '1027' });
    // exact past 2^53 — no rounding (the whole point of the int model)
    expect(literalize(9007199254740993n)).toEqual({ int: '9007199254740993' });
    expect(literalize(-42n)).toEqual({ int: '-42' });
  });

  it('a literalized BigInt survives the tx runtime\'s evaluateExpression pass (raw BigInt does NOT)', () => {
    // The write executor does `op.params.map((p) => evaluateExpression(p, scope))`. A raw BigInt node
    // is what threw "invalid node"; the literalized form evaluates back to the exact bc int.
    expect(() => evaluateExpression(1027n as never, {})).toThrow(); // the pre-fix behaviour
    expect(evaluateExpression(literalize(1027n) as never, {})).toBe(1027n);
    expect(evaluateExpression(literalize(9007199254740993n) as never, {})).toBe(9007199254740993n);
  });

  it('leaves every other scalar untouched (number/string/bool/null pass through verbatim)', () => {
    expect(literalize(5)).toBe(5);
    expect(literalize('x')).toBe('x');
    expect(literalize(true)).toBe(true);
    expect(literalize(null)).toBe(null);
    expect(literalize(undefined)).toBe(null);
  });

  it('recurses into arrays and objects so a nested BigInt is encoded too', () => {
    expect(literalize([1n, 'a'])).toEqual({ arr: [{ int: '1' }, 'a'] });
    expect(literalize({ id: 7n, name: 'z' })).toEqual({ obj: { id: { int: '7' }, name: 'z' } });
  });
});
