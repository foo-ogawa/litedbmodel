[API](../README.md) / InsertOptions

# Interface: InsertOptions\<Model\>

Defined in: [types.ts:158](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L158)

Insert options with type-safe column references.

## Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `Model = unknown` | The model class for type-safe column constraints |

## Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="tablename"></a> `tableName?` | `string` |  | [types.ts:159](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L159) |
| <a id="returning"></a> `returning?` | `boolean` | If true, return PkeyResult with affected primary keys. If false (default), return null for better performance. | [types.ts:164](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L164) |
| <a id="conflict"></a> `conflict?` | `string` | **Deprecated** Use onConflict instead | [types.ts:166](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L166) |
| <a id="onconflict"></a> `onConflict?` | [`Column`](../interfaces/Column.md)`<unknown, Model> \|`[`Column`](../interfaces/Column.md)`<unknown, Model>[]` | Columns for ON CONFLICT clause (unique constraint columns). Must be Column symbols from the same model for type safety.<br><br>**Example** // Single column onConflict: User.email // Multiple columns (composite unique constraint) onConflict: [UserPref.user_id, UserPref.key] | [types.ts:176](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L176) |
| <a id="onconflictupdate"></a> `onConflictUpdate?` | `'all' \|`[`Column`](../interfaces/Column.md)`<unknown, Model>[]` | Columns to update on conflict. Can be: - 'all': Update all inserted columns - Array of Column symbols from the same model<br><br>**Example** // Update all columns onConflictUpdate: 'all' // Update specific columns onConflictUpdate: [User.name, User.updated_at] | [types.ts:188](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L188) |
| <a id="onconflictignore"></a> `onConflictIgnore?` | `boolean` | If true, ignore the insert on conflict (DO NOTHING). Cannot be used with onConflictUpdate. | [types.ts:193](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L193) |

