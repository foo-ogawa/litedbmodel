/**
 * litedbmodel - MySQL Driver
 *
 * Database driver implementation for MySQL using mysql2.
 * The mysql2 package is dynamically loaded to make it an optional dependency.
 */

import type { DBConfig, DBDriver, DBDriverOptions, DBConnection, QueryResult, Logger } from './types';
import { defaultLogger } from './types';
import { isConnectionError, acquireCheckedConnection } from '../connection-errors';
import { isResendableStatement } from '../scp/middleware';
import { resolveTxOptions } from '../scp/tx-options';
import { mysqlDeboxPoolOptions, mysqlReturning, type MysqlQueryLike } from '../scp/makesql/pool-executor';
import { buildMysqlReselect } from '../scp/makesql/mysql-returning';

// mysql2 types (loaded dynamically)
interface Mysql2Pool {
  getConnection(): Promise<Mysql2PoolConnection>;
  query(sql: string, values?: unknown[]): Promise<[unknown[], unknown]>;
  end(): Promise<void>;
}

interface Mysql2PoolConnection {
  query(sql: string, values?: unknown[]): Promise<[unknown[], unknown]>;
  release(): void;
  destroy(): void;
}

interface Mysql2Module {
  createPool(config: {
    host?: string;
    port?: number;
    database: string;
    user?: string;
    password?: string;
    waitForConnections?: boolean;
    connectionLimit?: number;
    connectTimeout?: number;
    idleTimeout?: number;
    // v1/v2 read de-box (issue #9/#59): BIGINT → exact string, date family → native textual string.
    supportBigNumbers?: boolean;
    bigNumberStrings?: boolean;
    dateStrings?: boolean;
  }): Mysql2Pool;
}

// ============================================
// Connection Pool Management
// ============================================

const pools: Map<string, Mysql2Pool> = new Map();
let mysql2Module: Mysql2Module | null = null;

/**
 * Load mysql2 module dynamically
 */
function getMysql2Module(): Mysql2Module {
  if (!mysql2Module) {
    try {
      // Use mysql2/promise for async/await support
      mysql2Module = require('mysql2/promise') as Mysql2Module;
    } catch (_err) {
      throw new Error(
        'MySQL driver requires mysql2 package. Install it with: npm install mysql2'
      );
    }
  }
  return mysql2Module;
}

/**
 * Get pool cache key from config
 */
function getPoolKey(config: DBConfig): string {
  return `${config.host}:${config.port}/${config.database}`;
}

/**
 * Get or create a connection pool
 */
function getPool(config: DBConfig): Mysql2Pool {
  const key = getPoolKey(config);

  let pool = pools.get(key);
  if (!pool) {
    const mysql2 = getMysql2Module();
    pool = mysql2.createPool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      waitForConnections: true,
      connectionLimit: config.max || 10,
      connectTimeout: (config.timeout || 30) * 1000,
      idleTimeout: config.idleTimeoutMillis ?? 10000,
      // Read de-box (issue #9): make BIGINT arrive as an exact string (else mysql2 rounds it to a JS
      // number past 2^53) and the DATE/TIMESTAMP/DATETIME family arrive as its native textual string
      // (else a TZ-shifted JS Date) — the coercible forms `materializeCell` (int64/date) expects. Same
      // options the v2 SCP pool-executor sets (`mysqlDeboxPoolOptions`).
      ...mysqlDeboxPoolOptions,
    });
    pools.set(key, pool);
  }

  return pool;
}

/**
 * Close a specific pool
 */
async function closePool(config: DBConfig): Promise<void> {
  const key = getPoolKey(config);
  const pool = pools.get(key);
  if (pool) {
    await pool.end();
    pools.delete(key);
  }
}

/**
 * Close all connection pools
 */
export async function closeAllMysqlPools(): Promise<void> {
  for (const pool of pools.values()) {
    await pool.end();
  }
  pools.clear();
}

// ============================================
// Parameter Conversion
// ============================================

/**
 * Convert parameters to MySQL-compatible types
 * - boolean -> 0/1 (MySQL doesn't have true boolean type in older versions)
 */
function convertParams(params: unknown[]): unknown[] {
  return params.map((param) => {
    if (param === undefined) {
      return null;
    }
    // MySQL handles boolean as TINYINT(1), but node mysql2 converts automatically
    // Keep boolean as is for mysql2
    return param;
  });
}

/**
 * Convert ON CONFLICT syntax to MySQL ON DUPLICATE KEY syntax
 */
function convertOnConflictToMysql(sql: string): string {
  // Convert: ON CONFLICT (col) DO NOTHING
  // To: ON DUPLICATE KEY UPDATE col = col (no-op)
  const doNothingMatch = sql.match(/ON CONFLICT\s*\(([^)]+)\)\s*DO NOTHING/i);
  if (doNothingMatch) {
    const conflictCol = doNothingMatch[1].trim().split(',')[0].trim();
    return sql.replace(doNothingMatch[0], `ON DUPLICATE KEY UPDATE ${conflictCol} = ${conflictCol}`);
  }

  // Convert: ON CONFLICT (col) DO UPDATE SET col1 = EXCLUDED.col1, col2 = EXCLUDED.col2
  // To: ON DUPLICATE KEY UPDATE col1 = VALUES(col1), col2 = VALUES(col2)
  const doUpdateMatch = sql.match(/ON CONFLICT\s*\([^)]+\)\s*DO UPDATE SET\s+(.+?)(?:\s+RETURNING|$)/i);
  if (doUpdateMatch) {
    const setClause = doUpdateMatch[1];
    // Replace EXCLUDED.column with VALUES(column)
    const mysqlSetClause = setClause.replace(/EXCLUDED\.(\w+)/g, 'VALUES($1)');
    const fullMatch = sql.match(/ON CONFLICT\s*\([^)]+\)\s*DO UPDATE SET\s+.+?(?=\s+RETURNING|$)/i);
    if (fullMatch) {
      return sql.replace(fullMatch[0], `ON DUPLICATE KEY UPDATE ${mysqlSetClause}`);
    }
  }

  return sql;
}

/**
 * Run one statement on a mysql2 connection / pool and shape its result. MySQL parses no `RETURNING`: a
 * write that declares one ({@link buildMysqlReselect}) runs through the SAME emulation executor the SCP
 * connection adapter uses ({@link mysqlReturning}) — on ONE connection, which `connection` returns (a
 * transaction's own connection, or one checked out of the pool for the write and released after it).
 */
async function runMysql(
  sql: string,
  params: unknown[],
  query: MysqlQueryLike['query'],
  connection: () => Promise<{ conn: MysqlQueryLike; done: () => void }>,
): Promise<QueryResult> {
  const reselect = buildMysqlReselect(sql);
  if (reselect !== null) {
    const { conn, done } = await connection();
    try {
      const rows = (await mysqlReturning(conn, reselect, params)) as Record<string, unknown>[];
      return { rows, rowCount: rows.length };
    } finally {
      done();
    }
  }
  const [result] = await query(sql, params);
  if (Array.isArray(result)) {
    const rows = result as Record<string, unknown>[];
    return { rows, rowCount: rows.length };
  }
  return { rows: [], rowCount: ((result as Record<string, unknown>).affectedRows as number) ?? 0 };
}

/** One pooled connection for a RETURNING write, released after it. */
function pooledConnection(pool: Mysql2Pool): () => Promise<{ conn: MysqlQueryLike; done: () => void }> {
  return async () => {
    const conn = await pool.getConnection();
    return { conn, done: () => conn.release() };
  };
}

// ============================================
// MySQL Connection Wrapper
// ============================================

class MysqlConnection implements DBConnection {
  /** See {@link MysqlDriver.getConnection}: a pooled connection's SQL must reach the logger too. */
  constructor(private connection: Mysql2PoolConnection, private logger: Logger) {}

  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    // Handle MySQL-specific conversions
    const convertedSql = convertOnConflictToMysql(sql);
    this.logger.debug(`SQL: ${convertedSql}`, params ?? []);
    const conn = this.connection;
    return runMysql(convertedSql, convertParams(params || []), (q, v) => conn.query(q, v), async () => ({ conn, done: () => undefined }));
  }

  release(error?: Error | boolean): void {
    if (error) {
      this.connection.destroy();
    } else {
      this.connection.release();
    }
  }
}

// ============================================
// MySQL Driver
// ============================================

/**
 * MySQL database driver
 */
export class MysqlDriver implements DBDriver {
  readonly name = 'mysql';

  private pool: Mysql2Pool;
  private writerPool: Mysql2Pool | null;
  private config: DBConfig;
  private writerConfig: DBConfig | null;
  private logger: Logger;

  constructor(options: DBDriverOptions) {
    this.config = options.config;
    this.writerConfig = options.writerConfig || null;
    this.pool = getPool(options.config);
    this.writerPool = options.writerConfig ? getPool(options.writerConfig) : null;
    this.logger = options.logger || defaultLogger;
  }

  /**
   * Execute a read query. After a connection error the statement is re-sent once only when
   * `isResendableStatement` allows it (read-only and calls no function), on a connection that passed the
   * probe of {@link connect} (at most the default `retryLimit` connections are tried); anything else is
   * thrown.
   */
  async execute(sql: string, params: unknown[] = [], onWriter = false): Promise<QueryResult> {
    const pool = onWriter ? (this.writerPool || this.pool) : this.pool;
    // Handle MySQL-specific conversions
    const convertedSql = convertOnConflictToMysql(sql);
    const convertedParams = convertParams(params);
    this.logger.debug(`SQL: ${convertedSql}`, convertedParams);
    const run = () => runMysql(convertedSql, convertedParams, (q, v) => pool.query(q, v), pooledConnection(pool));

    const startTime = Date.now();
    try {
      const result = await run();
      this.logger.debug(`Query completed in ${Date.now() - startTime}ms, rows: ${result.rows.length}, affected: ${result.rowCount}`);
      return result;
    } catch (error) {
      if (isConnectionError(error as Error) && isResendableStatement(sql)) {
        this.logger.warn(`Connection error, retrying query: ${convertedSql}`);
        let conn: MysqlConnection | undefined;
        try {
          conn = await this.connect(pool, resolveTxOptions().retryLimit);
          const result = await conn.query(sql, params);
          conn.release();
          this.logger.debug(`Retry succeeded in ${Date.now() - startTime}ms, rows: ${result.rows.length}, affected: ${result.rowCount}`);
          return result;
        } catch (retryError) {
          conn?.release(retryError as Error);
          this.logger.error(`Retry also failed: ${convertedSql}`, retryError);
          throw retryError;
        }
      }
      this.logger.error(`Query failed: ${convertedSql}`, error);
      throw error;
    }
  }

  /**
   * Execute a write query (uses writer pool if available)
   */
  async executeWrite(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const pool = this.writerPool || this.pool;
    // Handle MySQL-specific conversions
    const convertedSql = convertOnConflictToMysql(sql);
    const convertedParams = convertParams(params);
    this.logger.debug(`SQL: ${convertedSql}`, convertedParams);

    const startTime = Date.now();
    try {
      const result = await runMysql(convertedSql, convertedParams, (q, v) => pool.query(q, v), pooledConnection(pool));
      this.logger.debug(`Write completed in ${Date.now() - startTime}ms, rows: ${result.rows.length}, affected: ${result.rowCount}`);
      return result;
    } catch (error) {
      this.logger.error(`Write failed: ${convertedSql}`, error);
      throw error;
    }
  }

  /**
   * Get a connection for transaction (uses writer pool if available)
   */
  async getConnection(checkAttempts?: number): Promise<DBConnection> {
    // Transactions always use writer pool for consistency
    return this.connect(this.writerPool || this.pool, checkAttempts);
  }

  /**
   * Acquire a connection from `pool` — the one acquisition point of the transaction and of the re-send
   * after a connection error. With `checkAttempts` (a retry after a connection error) each connection is
   * probed and a dead one destroyed and replaced, at most that many ({@link acquireCheckedConnection}).
   */
  private async connect(pool: Mysql2Pool, checkAttempts?: number): Promise<MysqlConnection> {
    const take = async (): Promise<MysqlConnection> => new MysqlConnection(await pool.getConnection(), this.logger);
    if (checkAttempts === undefined) return take();
    return acquireCheckedConnection(take, (conn, probe) => conn.query(probe), (conn) => conn.release(true), checkAttempts);
  }

  /**
   * Close all connections
   */
  async close(): Promise<void> {
    await closePool(this.config);
    if (this.writerConfig) {
      await closePool(this.writerConfig);
    }
  }

  /**
   * Set logger
   */
  setLogger(logger: Logger): void {
    this.logger = logger;
  }

  /**
   * Get the underlying pool (for advanced use)
   */
  getPool(): Mysql2Pool {
    return this.pool;
  }

  /**
   * Get the underlying writer pool
   */
  getWriterPool(): Mysql2Pool | null {
    return this.writerPool;
  }
}

/**
 * Create a MySQL driver instance
 */
export function createMysqlDriver(options: DBDriverOptions): MysqlDriver {
  return new MysqlDriver(options);
}

