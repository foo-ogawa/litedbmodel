/**
 * The v1 drivers cache their pools per configuration: two configurations share a pool only when they
 * would build the same one, so a second user / password on the same host and database gets its own pool
 * with its own credentials. (pg and mysql2 pools connect lazily — nothing here opens a connection.)
 */
import { describe, it, expect, afterAll } from 'vitest';
import { PostgresDriver, MysqlDriver, closeAllPools, closeAllMysqlPools } from '../../src/drivers';

afterAll(async () => {
  await closeAllPools();
  await closeAllMysqlPools();
});

const cfg = (user: string, password: string, port: number) => ({ host: 'pool-key.invalid', port, database: 'd', user, password });

describe('pool cache key', () => {
  it('postgres: a different user gets its own pool and credentials', () => {
    const reader = new PostgresDriver({ config: cfg('reader', 'r', 5432) } as never);
    const writer = new PostgresDriver({ config: cfg('writer', 'w', 5432) } as never);
    const again = new PostgresDriver({ config: cfg('reader', 'r', 5432) } as never);
    expect(writer.getPool()).not.toBe(reader.getPool());
    expect((writer.getPool() as unknown as { options: { user: string } }).options.user).toBe('writer');
    expect(again.getPool()).toBe(reader.getPool());
  });

  it('mysql: a different user gets its own pool and credentials', () => {
    const reader = new MysqlDriver({ config: { ...cfg('reader', 'r', 3306), driver: 'mysql' } } as never);
    const writer = new MysqlDriver({ config: { ...cfg('writer', 'w', 3306), driver: 'mysql' } } as never);
    const again = new MysqlDriver({ config: { ...cfg('reader', 'r', 3306), driver: 'mysql' } } as never);
    expect(writer.getPool()).not.toBe(reader.getPool());
    const user = (writer.getPool() as unknown as { pool: { config: { connectionConfig: { user: string } } } }).pool.config.connectionConfig.user;
    expect(user).toBe('writer');
    expect(again.getPool()).toBe(reader.getPool());
  });
});
