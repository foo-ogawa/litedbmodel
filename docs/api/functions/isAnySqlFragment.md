[API](../README.md) / isAnySqlFragment

# Function: isAnySqlFragment()

```ts
function isAnySqlFragment(value: unknown): value is SqlFragment | SqlTypedFragment | SqlCondition;
```

Defined in: [SqlFragment.ts:159](https://github.com/foo-ogawa/litedbmodel/blob/main/src/SqlFragment.ts#L159)

Matches any of SqlFragment, SqlTypedFragment, or SqlCondition.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `unknown` |

## Returns

`value is`[`SqlFragment`](../interfaces/SqlFragment.md)`|`[`SqlTypedFragment`](../interfaces/SqlTypedFragment.md)`|`[`SqlCondition`](../interfaces/SqlCondition.md)

