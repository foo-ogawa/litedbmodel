[**litedbmodel v2.2.3**](../README.md)

***

[litedbmodel](../globals.md) / SelectOptions

# Interface: SelectOptions

Defined in: types.ts:125

## Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="order"></a> `order?` | `string` \| `OrderSpec` | Order by clause. Accepts OrderSpec (Column.asc()/desc()) or raw string. | types.ts:127 |
| <a id="limit"></a> `limit?` | `number` | - | types.ts:128 |
| <a id="offset"></a> `offset?` | `number` | - | types.ts:129 |
| <a id="select"></a> `select?` | `string` | - | types.ts:130 |
| <a id="group"></a> `group?` | `string` | - | types.ts:131 |
| <a id="tablename"></a> `tableName?` | `string` | - | types.ts:132 |
| <a id="append"></a> `append?` | `string` | - | types.ts:133 |
| <a id="forupdate"></a> `forUpdate?` | `boolean` | Lock the selected rows EXCLUSIVELY (` FOR UPDATE`). Mutually exclusive with [forShare](#forshare). | types.ts:135 |
| <a id="forshare"></a> `forShare?` | `boolean` | Lock the selected rows for SHARE (` FOR SHARE`): concurrent readers may take the same shared lock, writers block until this transaction ends. The read-side twin of [forUpdate](#forupdate) (and mutually exclusive with it). PostgreSQL / MySQL only — SQLite parses no locking clause. | types.ts:141 |
| <a id="join"></a> `join?` | `string` | JOIN clause to add to the query. Can include parameters using ? placeholders. **Example** `join: 'JOIN unnest(?::int[]) AS _keys(id) ON t.id = _keys.id'` | types.ts:148 |
| <a id="joinparams"></a> `joinParams?` | `unknown`[] | Parameters for the JOIN clause (prepended to condition params). | types.ts:152 |
| <a id="cte"></a> `cte?` | \{ `name`: `string`; `sql`: `string`; `params`: `unknown`[]; \} | CTE (Common Table Expression) to prepend to the query. Used for window functions like ROW_NUMBER() or complex subqueries. The SQL should use ? placeholders for parameters. **Example** `cte: { name: 'ranked', sql: 'SELECT *, ROW_NUMBER() OVER (PARTITION BY user_id) AS _rn FROM posts WHERE user_id IN (?, ?)', params: [1, 2] }` | types.ts:164 |
| `cte.name` | `string` | - | types.ts:165 |
| `cte.sql` | `string` | - | types.ts:166 |
| `cte.params` | `unknown`[] | - | types.ts:167 |
