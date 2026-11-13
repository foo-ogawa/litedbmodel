[API](../README.md) / sql

# Function: sql()

```ts
function sql<V, M>(strings: TemplateStringsArray, col: Column<V, M>): SqlTypedFragment<V, M>;
```

Defined in: [SqlFragment.ts:249](https://github.com/foo-ogawa/litedbmodel/blob/main/src/SqlFragment.ts#L249)

Single Column interpolation → SqlTypedFragment (for Pattern A tuples or IS NULL conditions).

## Type Parameters

| Type Parameter |
| ------ |
| `V` |
| `M` |

## Parameters

| Parameter | Type |
| ------ | ------ |
| `strings` | `TemplateStringsArray` |
| `col` | [`Column`](../interfaces/Column.md)`<V, M>` |

## Returns

[`SqlTypedFragment`](../interfaces/SqlTypedFragment.md)`<V, M>`

***

```ts
function sql<V, M>(strings: TemplateStringsArray, col: Column<V, M>, value: V): SqlCondition<M>;
```

Defined in: [SqlFragment.ts:257](https://github.com/foo-ogawa/litedbmodel/blob/main/src/SqlFragment.ts#L257)

Single Column + 1 value → SqlCondition (Pattern B: `sql\`${Col} > ${value}\``).

## Type Parameters

| Type Parameter |
| ------ |
| `V` |
| `M` |

## Parameters

| Parameter | Type |
| ------ | ------ |
| `strings` | `TemplateStringsArray` |
| `col` | [`Column`](../interfaces/Column.md)`<V, M>` |
| `value` | `V` |

## Returns

[`SqlCondition`](../interfaces/SqlCondition.md)`<M>`

***

```ts
function sql<V, M>(strings: TemplateStringsArray, col: Column<V, M>, v1: V, v2: V): SqlCondition<M>;
```

Defined in: [SqlFragment.ts:266](https://github.com/foo-ogawa/litedbmodel/blob/main/src/SqlFragment.ts#L266)

Single Column + 2 values → SqlCondition (Pattern B: BETWEEN).

## Type Parameters

| Type Parameter |
| ------ |
| `V` |
| `M` |

## Parameters

| Parameter | Type |
| ------ | ------ |
| `strings` | `TemplateStringsArray` |
| `col` | [`Column`](../interfaces/Column.md)`<V, M>` |
| `v1` | `V` |
| `v2` | `V` |

## Returns

[`SqlCondition`](../interfaces/SqlCondition.md)`<M>`

***

```ts
function sql<V, M>(strings: TemplateStringsArray, col: Column<V, M>, values: readonly V[]): SqlCondition<M>;
```

Defined in: [SqlFragment.ts:276](https://github.com/foo-ogawa/litedbmodel/blob/main/src/SqlFragment.ts#L276)

Single Column + array → SqlCondition (Pattern B: IN).

## Type Parameters

| Type Parameter |
| ------ |
| `V` |
| `M` |

## Parameters

| Parameter | Type |
| ------ | ------ |
| `strings` | `TemplateStringsArray` |
| `col` | [`Column`](../interfaces/Column.md)`<V, M>` |
| `values` | `readonly V[]` |

## Returns

[`SqlCondition`](../interfaces/SqlCondition.md)`<M>`

***

```ts
function sql(strings: TemplateStringsArray, ...values: (Column<any, any> | { TABLE_NAME: string } | SqlRaw | SqlRef | DBParentRef)[]): SqlFragment;
```

Defined in: [SqlFragment.ts:285](https://github.com/foo-ogawa/litedbmodel/blob/main/src/SqlFragment.ts#L285)

Multiple Columns / TABLE_NAME only → SqlFragment (for QUERY).

## Parameters

| Parameter | Type |
| ------ | ------ |
| `strings` | `TemplateStringsArray` |
| `...values` | `(`[`Column`](../interfaces/Column.md)`<any, any> \| { TABLE_NAME: string } \|`[`SqlRaw`](../classes/SqlRaw.md)`\|`[`SqlRef`](../classes/SqlRef.md)`\| DBParentRef)[]` |

## Returns

[`SqlFragment`](../interfaces/SqlFragment.md)

***

```ts
function sql(strings: TemplateStringsArray, ...values: SqlInterpolation[]): SqlFragment;
```

Defined in: [SqlFragment.ts:293](https://github.com/foo-ogawa/litedbmodel/blob/main/src/SqlFragment.ts#L293)

General: mixed interpolation → SqlFragment (for withQuery / execute).

## Parameters

| Parameter | Type |
| ------ | ------ |
| `strings` | `TemplateStringsArray` |
| `...values` | [`SqlInterpolation`](../README.md#sqlinterpolation)`[]` |

## Returns

[`SqlFragment`](../interfaces/SqlFragment.md)

