[**litedbmodel v2.2.8**](../README.md)

***

[litedbmodel](../globals.md) / Column

# Interface: Column()\<ValueType, ModelType\>

Defined in: [Column.ts:145](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L145)

Type-safe column reference as a callable function.

## Type Parameters

| Type Parameter | Default type | Description |
| ------ | ------ | ------ |
| `ValueType` | `unknown` | The TypeScript type of the column value |
| `ModelType` | `unknown` | The model class this column belongs to (for relation type safety) - Call `User.id()` to get the column name as a string (for computed property keys) - Use methods like `User.id.eq(1)` for condition builders - Use in template literals: `${User.id}` (calls toString()) |

```ts
Column(): string;
```

Defined in: [Column.ts:147](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L147)

Call to get column name as string (for computed property keys)

## Returns

`string`

## Properties

| Property | Modifier | Type | Description | Defined in |
| ------ | ------ | ------ | ------ | ------ |
| <a id="columnname"></a> `columnName` | `readonly` | `string` | The database column name | [Column.ts:150](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L150) |
| <a id="propertyname"></a> `propertyName` | `readonly` | `string` | The property name on the model class (may differ from columnName) | [Column.ts:153](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L153) |
| <a id="tablename"></a> `tableName` | `readonly` | `string` | The database table name | [Column.ts:156](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L156) |
| <a id="modelname"></a> `modelName` | `readonly` | `string` | The model class name (for debugging and static analysis) | [Column.ts:159](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L159) |
| <a id="_brand"></a> `_brand` | `readonly` | `"Column"` | Brand for type discrimination - enables static analysis to distinguish from regular variables | [Column.ts:162](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L162) |
| <a id="sqlcast"></a> `sqlCast?` | `readonly` | `string` | SQL type for automatic casting in conditions (e.g., 'uuid') | [Column.ts:165](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L165) |
| <a id="serialize"></a> `serialize?` | `readonly` | (`value`: `unknown`, `typeCast?`: `DriverTypeCast`) => `unknown` | The column family's serializer: a condition value binds exactly as a written value does | [Column.ts:168](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L168) |
| <a id="__model"></a> `__model?` | `readonly` | `ModelType` | Phantom type for model association (compile-time only, not used at runtime) | [Column.ts:171](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L171) |

## Methods

### eq()

```ts
eq(value: ValueType): Record<string, ValueType | DBCast>;
```

Defined in: [Column.ts:181](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L181)

Equal condition (column = value)

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `ValueType` |

#### Returns

`Record`\<`string`, `ValueType` \| `DBCast`\>

#### Example

```ts
User.id.eq(1) → { id: 1 }
```

***

### ne()

```ts
ne(value: ValueType): Record<string, ValueType | DBCast>;
```

Defined in: [Column.ts:187](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L187)

Not equal condition (column != value)

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `ValueType` |

#### Returns

`Record`\<`string`, `ValueType` \| `DBCast`\>

#### Example

```ts
User.status.ne('deleted') → { 'status != ?': 'deleted' }
```

***

### gt()

```ts
gt(value: ValueType): Record<string, ValueType | DBCast>;
```

Defined in: [Column.ts:193](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L193)

Greater than condition (column > value)

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `ValueType` |

#### Returns

`Record`\<`string`, `ValueType` \| `DBCast`\>

#### Example

```ts
User.age.gt(18) → { 'age > ?': 18 }
```

***

### gte()

```ts
gte(value: ValueType): Record<string, ValueType | DBCast>;
```

Defined in: [Column.ts:199](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L199)

Greater than or equal condition (column >= value)

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `ValueType` |

#### Returns

`Record`\<`string`, `ValueType` \| `DBCast`\>

#### Example

```ts
User.age.gte(18) → { 'age >= ?': 18 }
```

***

### lt()

```ts
lt(value: ValueType): Record<string, ValueType | DBCast>;
```

Defined in: [Column.ts:205](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L205)

Less than condition (column < value)

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `ValueType` |

#### Returns

`Record`\<`string`, `ValueType` \| `DBCast`\>

#### Example

```ts
User.age.lt(65) → { 'age < ?': 65 }
```

***

### lte()

```ts
lte(value: ValueType): Record<string, ValueType | DBCast>;
```

Defined in: [Column.ts:211](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L211)

Less than or equal condition (column <= value)

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `ValueType` |

#### Returns

`Record`\<`string`, `ValueType` \| `DBCast`\>

#### Example

```ts
User.age.lte(65) → { 'age <= ?': 65 }
```

***

### like()

```ts
like(pattern: string): Record<string, string>;
```

Defined in: [Column.ts:217](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L217)

LIKE condition (column LIKE pattern)

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `pattern` | `string` |

#### Returns

`Record`\<`string`, `string`\>

#### Example

```ts
User.name.like('%test%') → { 'name LIKE ?': '%test%' }
```

***

### notLike()

```ts
notLike(pattern: string): Record<string, string>;
```

Defined in: [Column.ts:223](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L223)

NOT LIKE condition (column NOT LIKE pattern)

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `pattern` | `string` |

#### Returns

`Record`\<`string`, `string`\>

#### Example

```ts
User.name.notLike('%test%') → { 'name NOT LIKE ?': '%test%' }
```

***

### ilike()

```ts
ilike(pattern: string): Record<string, string>;
```

Defined in: [Column.ts:229](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L229)

ILIKE condition (case-insensitive LIKE, PostgreSQL specific)

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `pattern` | `string` |

#### Returns

`Record`\<`string`, `string`\>

#### Example

```ts
User.name.ilike('%TEST%') → { 'name ILIKE ?': '%TEST%' }
```

***

### between()

```ts
between(from: ValueType, to: ValueType): Record<string, [ValueType, ValueType]>;
```

Defined in: [Column.ts:235](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L235)

BETWEEN condition (column BETWEEN from AND to)

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `from` | `ValueType` |
| `to` | `ValueType` |

#### Returns

`Record`\<`string`, \[`ValueType`, `ValueType`\]\>

#### Example

```ts
User.age.between(18, 65) → { 'age BETWEEN ? AND ?': [18, 65] }
```

***

### in()

```ts
in(values: ValueType[]): Record<string, ValueType[] | DBCastArray>;
```

Defined in: [Column.ts:242](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L242)

IN condition (column IN (values))
Note: Arrays are automatically converted to IN clause by litedbmodel

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `values` | `ValueType`[] |

#### Returns

`Record`\<`string`, `ValueType`[] \| `DBCastArray`\>

#### Example

```ts
User.status.in(['active', 'pending']) → { status: ['active', 'pending'] }
```

***

### notIn()

```ts
notIn(values: ValueType[]): Record<string, ValueType[] | DBCastArray>;
```

Defined in: [Column.ts:248](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L248)

NOT IN condition (column NOT IN (values))

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `values` | `ValueType`[] |

#### Returns

`Record`\<`string`, `ValueType`[] \| `DBCastArray`\>

#### Example

```ts
User.status.notIn(['deleted', 'banned'])
```

***

### isNull()

```ts
isNull(): Record<string, null>;
```

Defined in: [Column.ts:254](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L254)

IS NULL condition

#### Returns

`Record`\<`string`, `null`\>

#### Example

```ts
User.deleted_at.isNull() → { deleted_at: null }
```

***

### isNotNull()

```ts
isNotNull(): Record<string, DBNotNullValue>;
```

Defined in: [Column.ts:260](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L260)

IS NOT NULL condition

#### Returns

`Record`\<`string`, `DBNotNullValue`\>

#### Example

```ts
User.email.isNotNull() → { email: DBNotNullValue }
```

***

### asc()

```ts
asc(): OrderColumn<ModelType>;
```

Defined in: [Column.ts:270](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L270)

Ascending order

#### Returns

`OrderColumn`\<`ModelType`\>

#### Example

```ts
User.created_at.asc() → OrderColumn('created_at', 'ASC')
```

***

### desc()

```ts
desc(): OrderColumn<ModelType>;
```

Defined in: [Column.ts:276](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L276)

Descending order

#### Returns

`OrderColumn`\<`ModelType`\>

#### Example

```ts
User.created_at.desc() → OrderColumn('created_at', 'DESC')
```

***

### ascNullsFirst()

```ts
ascNullsFirst(): OrderColumn<ModelType>;
```

Defined in: [Column.ts:282](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L282)

Ascending order with NULLS FIRST

#### Returns

`OrderColumn`\<`ModelType`\>

#### Example

```ts
User.updated_at.ascNullsFirst() → OrderColumn with NULLS FIRST
```

***

### ascNullsLast()

```ts
ascNullsLast(): OrderColumn<ModelType>;
```

Defined in: [Column.ts:288](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L288)

Ascending order with NULLS LAST

#### Returns

`OrderColumn`\<`ModelType`\>

#### Example

```ts
User.updated_at.ascNullsLast() → OrderColumn with NULLS LAST
```

***

### descNullsFirst()

```ts
descNullsFirst(): OrderColumn<ModelType>;
```

Defined in: [Column.ts:294](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L294)

Descending order with NULLS FIRST

#### Returns

`OrderColumn`\<`ModelType`\>

#### Example

```ts
User.updated_at.descNullsFirst() → OrderColumn with NULLS FIRST
```

***

### descNullsLast()

```ts
descNullsLast(): OrderColumn<ModelType>;
```

Defined in: [Column.ts:300](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L300)

Descending order with NULLS LAST

#### Returns

`OrderColumn`\<`ModelType`\>

#### Example

```ts
User.updated_at.descNullsLast() → OrderColumn with NULLS LAST
```

***

### toString()

```ts
toString(): string;
```

Defined in: [Column.ts:310](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L310)

Returns column name (for template literals)

#### Returns

`string`

#### Example

```ts
`${User.id}` → 'id'
```
