[API](../README.md) / SelectOptions

# Interface: SelectOptions

Defined in: [types.ts:115](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L115)

## Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="order"></a> `order?` | `import('./Column').OrderSpec \| string` | Order by clause. Accepts OrderSpec (Column.asc()/desc()) or raw string. | [types.ts:117](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L117) |
| <a id="limit"></a> `limit?` | `number` |  | [types.ts:118](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L118) |
| <a id="offset"></a> `offset?` | `number` |  | [types.ts:119](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L119) |
| <a id="select"></a> `select?` | `string` |  | [types.ts:120](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L120) |
| <a id="group"></a> `group?` | `string` |  | [types.ts:121](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L121) |
| <a id="tablename"></a> `tableName?` | `string` |  | [types.ts:122](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L122) |
| <a id="append"></a> `append?` | `string` |  | [types.ts:123](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L123) |
| <a id="forupdate"></a> `forUpdate?` | `boolean` |  | [types.ts:124](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L124) |
| <a id="join"></a> `join?` | `string` | JOIN clause to add to the query. Can include parameters using ? placeholders.<br><br>**Example** join: 'JOIN unnest(?::int[]) AS _keys(id) ON t.id = _keys.id' | [types.ts:131](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L131) |
| <a id="joinparams"></a> `joinParams?` | `unknown[]` | Parameters for the JOIN clause (prepended to condition params). | [types.ts:135](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L135) |
| <a id="cte"></a> `cte?` | `{ name: string;`[`sql`](../functions/sql.md)`: string; params: unknown[]; }` | CTE (Common Table Expression) to prepend to the query. Used for window functions like ROW_NUMBER() or complex subqueries. The SQL should use ? placeholders for parameters.<br><br>**Example** cte: { name: 'ranked', sql: 'SELECT *, ROW_NUMBER() OVER (PARTITION BY user_id) AS _rn FROM posts WHERE user_id IN (?, ?)', params: [1, 2] } | [types.ts:147](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L147) |

