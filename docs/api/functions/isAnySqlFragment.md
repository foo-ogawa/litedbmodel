[API](../README.md) / isAnySqlFragment

# Function: isAnySqlFragment()

```ts
function isAnySqlFragment(value: unknown): value is SqlFragment | SqlTypedFragment | SqlCondition;
```

Defined in: [SqlFragment.ts:149](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/SqlFragment.ts#L149)

Matches any of SqlFragment, SqlTypedFragment, or SqlCondition.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `unknown` |

## Returns

`value is`[`SqlFragment`](../interfaces/SqlFragment.md)`|`[`SqlTypedFragment`](../interfaces/SqlTypedFragment.md)`|`[`SqlCondition`](../interfaces/SqlCondition.md)

