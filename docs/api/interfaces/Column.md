[API](../README.md) / Column

# Interface: Column\<ValueType, ModelType\>

Defined in: [Column.ts:146](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L146)

Type-safe column reference as a callable function.

## Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `ValueType = unknown` | The TypeScript type of the column value |
| `ModelType = unknown` | The model class this column belongs to (for relation type safety)<br><br>- Call `User.id()` to get the column name as a string (for computed property keys) - Use methods like `User.id.eq(1)` for condition builders - Use in template literals: `${User.id}` (calls toString()) |

## Call Signature

```ts
(): string;
```

Defined in: [Column.ts:148](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L148)

Call to get column name as string (for computed property keys)

### Returns

`string`

## Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="columnname"></a> `columnName` (readonly) | `string` | The database column name | [Column.ts:151](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L151) |
| <a id="propertyname"></a> `propertyName` (readonly) | `string` | The property name on the model class (may differ from columnName) | [Column.ts:154](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L154) |
| <a id="tablename"></a> `tableName` (readonly) | `string` | The database table name | [Column.ts:157](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L157) |
| <a id="modelname"></a> `modelName` (readonly) | `string` | The model class name (for debugging and static analysis) | [Column.ts:160](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L160) |
| <a id="_brand"></a> `_brand` (readonly) | `'Column'` | Brand for type discrimination - enables static analysis to distinguish from regular variables | [Column.ts:163](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L163) |
| <a id="sqlcast"></a> `sqlCast?` (readonly) | `string` | SQL type for automatic casting in conditions (e.g., 'uuid') | [Column.ts:166](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L166) |
| <a id="serialize"></a> `serialize?` (readonly) | `(value: unknown, typeCast?: DriverTypeCast) => unknown` | The column family's serializer: a condition value binds exactly as a written value does | [Column.ts:169](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L169) |
| <a id="__model"></a> `__model?` (readonly) | `ModelType` | Phantom type for model association (compile-time only, not used at runtime) | [Column.ts:172](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L172) |

## Methods

### eq()

```ts
eq(value: ValueType): Record<string, ValueType | DBCast>;
```

Defined in: [Column.ts:182](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L182)

Equal condition (column = value)

#### Example

User.id.eq(1) → { id: 1 }

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `ValueType` |

#### Returns

`Record<string, ValueType | DBCast>`

***

### ne()

```ts
ne(value: ValueType): Record<string, ValueType | DBCast>;
```

Defined in: [Column.ts:188](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L188)

Not equal condition (column != value)

#### Example

User.status.ne('deleted') → { 'status != ?': 'deleted' }

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `ValueType` |

#### Returns

`Record<string, ValueType | DBCast>`

***

### gt()

```ts
gt(value: ValueType): Record<string, ValueType | DBCast>;
```

Defined in: [Column.ts:194](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L194)

Greater than condition (column > value)

#### Example

User.age.gt(18) → { 'age > ?': 18 }

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `ValueType` |

#### Returns

`Record<string, ValueType | DBCast>`

***

### gte()

```ts
gte(value: ValueType): Record<string, ValueType | DBCast>;
```

Defined in: [Column.ts:200](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L200)

Greater than or equal condition (column >= value)

#### Example

User.age.gte(18) → { 'age >= ?': 18 }

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `ValueType` |

#### Returns

`Record<string, ValueType | DBCast>`

***

### lt()

```ts
lt(value: ValueType): Record<string, ValueType | DBCast>;
```

Defined in: [Column.ts:206](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L206)

Less than condition (column < value)

#### Example

User.age.lt(65) → { 'age < ?': 65 }

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `ValueType` |

#### Returns

`Record<string, ValueType | DBCast>`

***

### lte()

```ts
lte(value: ValueType): Record<string, ValueType | DBCast>;
```

Defined in: [Column.ts:212](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L212)

Less than or equal condition (column <= value)

#### Example

User.age.lte(65) → { 'age <= ?': 65 }

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `ValueType` |

#### Returns

`Record<string, ValueType | DBCast>`

***

### like()

```ts
like(pattern: string): Record<string, string>;
```

Defined in: [Column.ts:218](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L218)

LIKE condition (column LIKE pattern)

#### Example

User.name.like('%test%') → { 'name LIKE ?': '%test%' }

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `pattern` | `string` |

#### Returns

`Record<string, string>`

***

### notLike()

```ts
notLike(pattern: string): Record<string, string>;
```

Defined in: [Column.ts:224](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L224)

NOT LIKE condition (column NOT LIKE pattern)

#### Example

User.name.notLike('%test%') → { 'name NOT LIKE ?': '%test%' }

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `pattern` | `string` |

#### Returns

`Record<string, string>`

***

### ilike()

```ts
ilike(pattern: string): Record<string, string>;
```

Defined in: [Column.ts:230](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L230)

ILIKE condition (case-insensitive LIKE, PostgreSQL specific)

#### Example

User.name.ilike('%TEST%') → { 'name ILIKE ?': '%TEST%' }

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `pattern` | `string` |

#### Returns

`Record<string, string>`

***

### between()

```ts
between(from: ValueType, to: ValueType): Record<string, [ValueType, ValueType]>;
```

Defined in: [Column.ts:236](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L236)

BETWEEN condition (column BETWEEN from AND to)

#### Example

User.age.between(18, 65) → { 'age BETWEEN ? AND ?': [18, 65] }

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `from` | `ValueType` |
| `to` | `ValueType` |

#### Returns

`Record<string, [ValueType, ValueType]>`

***

### in()

```ts
in(values: ValueType[]): Record<string, ValueType[] | DBCastArray>;
```

Defined in: [Column.ts:243](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L243)

IN condition (column IN (values))
Note: Arrays are automatically converted to IN clause by litedbmodel

#### Example

User.status.in(['active', 'pending']) → { status: ['active', 'pending'] }

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `values` | `ValueType[]` |

#### Returns

`Record<string, ValueType[] | DBCastArray>`

***

### notIn()

```ts
notIn(values: ValueType[]): Record<string, ValueType[] | DBCastArray>;
```

Defined in: [Column.ts:249](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L249)

NOT IN condition (column NOT IN (values))

#### Example

User.status.notIn(['deleted', 'banned'])

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `values` | `ValueType[]` |

#### Returns

`Record<string, ValueType[] | DBCastArray>`

***

### isNull()

```ts
isNull(): Record<string, null>;
```

Defined in: [Column.ts:255](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L255)

IS NULL condition

#### Example

User.deleted_at.isNull() → { deleted_at: null }

#### Returns

`Record<string, null>`

***

### isNotNull()

```ts
isNotNull(): Record<string, DBNotNullValue>;
```

Defined in: [Column.ts:261](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L261)

IS NOT NULL condition

#### Example

User.email.isNotNull() → { email: DBNotNullValue }

#### Returns

`Record<string, DBNotNullValue>`

***

### asc()

```ts
asc(): OrderColumn<ModelType>;
```

Defined in: [Column.ts:271](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L271)

Ascending order

#### Example

User.created_at.asc() → OrderColumn('created_at', 'ASC')

#### Returns

`OrderColumn<ModelType>`

***

### desc()

```ts
desc(): OrderColumn<ModelType>;
```

Defined in: [Column.ts:277](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L277)

Descending order

#### Example

User.created_at.desc() → OrderColumn('created_at', 'DESC')

#### Returns

`OrderColumn<ModelType>`

***

### ascNullsFirst()

```ts
ascNullsFirst(): OrderColumn<ModelType>;
```

Defined in: [Column.ts:283](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L283)

Ascending order with NULLS FIRST

#### Example

User.updated_at.ascNullsFirst() → OrderColumn with NULLS FIRST

#### Returns

`OrderColumn<ModelType>`

***

### ascNullsLast()

```ts
ascNullsLast(): OrderColumn<ModelType>;
```

Defined in: [Column.ts:289](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L289)

Ascending order with NULLS LAST

#### Example

User.updated_at.ascNullsLast() → OrderColumn with NULLS LAST

#### Returns

`OrderColumn<ModelType>`

***

### descNullsFirst()

```ts
descNullsFirst(): OrderColumn<ModelType>;
```

Defined in: [Column.ts:295](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L295)

Descending order with NULLS FIRST

#### Example

User.updated_at.descNullsFirst() → OrderColumn with NULLS FIRST

#### Returns

`OrderColumn<ModelType>`

***

### descNullsLast()

```ts
descNullsLast(): OrderColumn<ModelType>;
```

Defined in: [Column.ts:301](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L301)

Descending order with NULLS LAST

#### Example

User.updated_at.descNullsLast() → OrderColumn with NULLS LAST

#### Returns

`OrderColumn<ModelType>`

***

### toString()

```ts
toString(): string;
```

Defined in: [Column.ts:311](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L311)

Returns column name (for template literals)

#### Example

`${User.id}` → 'id'

#### Returns

`string`

