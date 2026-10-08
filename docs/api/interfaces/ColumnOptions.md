[**litedbmodel v2.2.8**](../README.md)

***

[litedbmodel](../globals.md) / ColumnOptions

# Interface: ColumnOptions

Defined in: [decorators.ts:327](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L327)

Options that can be passed to any `@column.*` decorator

## Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="columnname"></a> `columnName?` | `string` | Custom column name (defaults to property name) | [decorators.ts:329](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L329) |
| <a id="primarykey"></a> `primaryKey?` | `boolean` | Mark this column as part of the primary key | [decorators.ts:331](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L331) |
| <a id="autoincrement"></a> `autoIncrement?` | `boolean` | The SERVER assigns this column's value (`AUTO_INCREMENT` / `SERIAL` / `IDENTITY`) — a write does not supply it. Declare it on an auto-increment primary key so a `RETURNING` write can recover the rows it wrote on a dialect that has no native `RETURNING`. See ColumnMeta.autoIncrement. | [decorators.ts:337](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L337) |
