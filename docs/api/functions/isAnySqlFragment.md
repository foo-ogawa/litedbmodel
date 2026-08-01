[**litedbmodel v2.2.4**](../README.md)

***

[litedbmodel](../globals.md) / isAnySqlFragment

# Function: isAnySqlFragment()

```ts
function isAnySqlFragment(value: unknown): value is SqlFragment | SqlTypedFragment<unknown, unknown> | SqlCondition<unknown>;
```

Defined in: [SqlFragment.ts:149](https://github.com/foo-ogawa/litedbmodel/blob/main/src/SqlFragment.ts#L149)

Matches any of SqlFragment, SqlTypedFragment, or SqlCondition.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `unknown` |

## Returns

value is SqlFragment \| SqlTypedFragment\<unknown, unknown\> \| SqlCondition\<unknown\>
