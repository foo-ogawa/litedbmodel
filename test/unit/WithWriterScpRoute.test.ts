/**
 * #355 — reads inside `DBModel.withWriter()` go to the writer on the SCP route too.
 *
 * `DBModel.withWriter` entered only the v1 writer context, while the SCP route picks its pool from the
 * SCP writer scope (`resolvePool` → `inWriterScope()`), so every read inside it was served by the
 * READER — the replica lag withWriter exists to avoid (README: "Inside withWriter() | Writer").
 */
import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { DBModel, model, column, WriteInReadOnlyContextError } from '../../src';
import {
  PooledAsyncContext,
  ConnectionRegistry,
  WriterStickyClock,
  type AsyncConnection,
  type AsyncConnectionPool,
} from '../../src/scp';

const served: string[] = [];
function pool(name: 'reader' | 'writer'): AsyncConnectionPool {
  const conn: AsyncConnection = {
    async execute(sql) {
      served.push(`${name}: ${sql}`);
      return [{ id: 1, balance: name === 'writer' ? 0 : 100 }];
    },
    async run(sql) {
      served.push(`${name}: ${sql}`);
      return { changes: 0, lastInsertRowid: 0 };
    },
  };
  return { async acquire() { return conn; }, async release() {} };
}

const registry = ConnectionRegistry.fromDefault({ reader: pool('reader'), writer: pool('writer') }).build();
const ctx = new PooledAsyncContext({ registry, sticky: new WriterStickyClock({ useWriterAfterTransaction: false }) });
class ScpBase extends DBModel {
  protected static _getScpRuntime() { return { ctx, dialect: 'postgres', close: async () => {} } as never; }
}
@model('accounts')
class AccountModel extends ScpBase {
  @column.number({ primaryKey: true }) id?: number;
  @column.number() balance?: number;
}
const Account = AccountModel.asModel();

describe('DBModel.withWriter on the SCP route (#355)', () => {
  it('a find() inside withWriter is served by the writer', async () => {
    served.length = 0;
    const rows = await Account.withWriter(() => Account.find([[Account.id, 1]]));
    expect(rows.map((r) => r.balance)).toEqual([0]);
    expect(served).toEqual(['writer: SELECT * FROM accounts WHERE id = $1']);
  });

  it('an execute() SELECT inside withWriter is served by the writer', async () => {
    served.length = 0;
    await Account.withWriter(() => Account.execute('SELECT balance FROM accounts WHERE id = $1', [1]));
    expect(served).toEqual(['writer: SELECT balance FROM accounts WHERE id = $1']);
  });

  it('outside withWriter the same read is served by the reader', async () => {
    served.length = 0;
    await Account.find([[Account.id, 1]]);
    expect(served).toEqual(['reader: SELECT * FROM accounts WHERE id = $1']);
  });

  it('a write inside withWriter is still rejected', async () => {
    await expect(Account.withWriter(() => Account.create([[Account.balance, 1]]))).rejects.toBeInstanceOf(
      WriteInReadOnlyContextError,
    );
  });
});
