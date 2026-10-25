// litedbmodel v2 SCP — Phase C (#89, go) driver POOL FACTORIES.
//
// The go analogue of the TS `makesql/pool-executor.ts` pgPoolFactory / mysqlPoolFactory (#87):
// [BuildRoutingConfig] OWNS pool construction so the C3 config's CONSTRUCTION knobs — pool sizing
// (MaxPool) + IdleTimeoutMillis + KeepAlive/KeepAliveInitialDelayMillis + ConnectTimeoutMillis — reach
// the real *sql.DB and its driver at construction.
//
// The critical go-specific point (the #87 blocker was passing a pre-built pool that IGNORED sizing):
// go's database/sql sizing is set on the *sql.DB AFTER it is opened — so the factory opens it and THEN
// applies SetMaxOpenConns / SetMaxIdleConns / SetConnMaxIdleTime on the FRESH *sql.DB. The configured
// MaxOpenConns is thus the SOLE bound on live connections; there is no second un-sized *sql.DB path.
// The driver-side knobs travel in the driver's own config: the connect timeout (its connect bound) and
// the TCP keepalive (the dialer it opens sockets with); the connect timeout also bounds every
// [SQLDBPool] checkout. Session knobs (queryTimeout/searchPath/charset) are layered separately by
// [ConfiguredPool] on checkout.

package litedbmodel_runtime

import (
	"database/sql"
	"fmt"
	"net"
	"strconv"
	"time"

	gomysql "github.com/go-sql-driver/mysql"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

// applyPoolSizing applies the C3 pool knobs to a freshly-opened *sql.DB (the go equivalent of pg's
// `new Pool({max, idleTimeoutMillis})` — set on the *sql.DB, not passed to the driver). MaxOpenConns =
// MaxPool is the SOLE cap on live connections. A released connection is kept idle (MaxIdleConns =
// MaxPool) and closed once it has been unused for IdleTimeoutMillis (SetConnMaxIdleTime) — the one
// source of the idle bound. No lifetime bound is set: a connection lives until it idles out or breaks.
// MinPool has no database/sql mapping (no idle floor; see [ConnectionConfig.MinPool]).
func applyPoolSizing(db *sql.DB, config ResolvedConnectionConfig) {
	db.SetMaxOpenConns(config.MaxPool) // ← the SOLE cap source (config.MaxPool only)
	db.SetMaxIdleConns(config.MaxPool)
	db.SetConnMaxIdleTime(time.Duration(config.IdleTimeoutMillis) * time.Millisecond)
}

// tcpDialer is the dialer both drivers open their TCP connections with — where KeepAlive lands.
// KeepAlive=true turns TCP keepalive on with the first probe after KeepAliveInitialDelayMillis of
// idleness (net.Dialer.KeepAlive). KeepAlive=false turns it OFF (a negative KeepAlive): the contract's
// false is the TS drivers' false — pg and mysql2 leave the socket without keepalive unless asked — and
// a zero net.Dialer.KeepAlive would instead switch Go's own default (keepalive every 15s) on.
func tcpDialer(c ResolvedConnectionConfig) *net.Dialer {
	keepAlive := time.Duration(-1)
	if c.KeepAlive {
		keepAlive = time.Duration(c.KeepAliveInitialDelayMillis) * time.Millisecond
	}
	return &net.Dialer{KeepAlive: keepAlive}
}

// pgDSN builds a pgx-stdlib DSN from a resolved config (postgres://user:pass@host:port/db?sslmode=disable).
func pgDSN(c ResolvedConnectionConfig) string {
	sslmode := "disable"
	return fmt.Sprintf("postgres://%s:%s@%s:%d/%s?sslmode=%s", c.User, c.Password, c.Host, c.Port, c.Database, sslmode)
}

// pgConnConfig is the pgx config [PgPoolFactory] opens its *sql.DB with: the DSN's connection params,
// ConnectTimeout = ConnectTimeoutMillis (the whole connect — dial + startup — at millisecond precision;
// pgx reads 0 as no limit) and the [tcpDialer].
func pgConnConfig(c ResolvedConnectionConfig) (*pgx.ConnConfig, error) {
	connConfig, err := pgx.ParseConfig(pgDSN(c))
	if err != nil {
		return nil, err
	}
	connConfig.ConnectTimeout = time.Duration(c.ConnectTimeoutMillis) * time.Millisecond
	connConfig.DialFunc = tcpDialer(c).DialContext
	return connConfig, nil
}

// mysqlConfig is the go-sql-driver config [MysqlPoolFactory] opens its *sql.DB with: the connection
// params, Timeout = ConnectTimeoutMillis (the dial; the driver reads 0 as no limit) and the [tcpDialer].
func mysqlConfig(c ResolvedConnectionConfig) *gomysql.Config {
	cfg := gomysql.NewConfig()
	cfg.User = c.User
	cfg.Passwd = c.Password
	cfg.Net = "tcp"
	cfg.Addr = net.JoinHostPort(c.Host, strconv.Itoa(c.Port))
	cfg.DBName = c.Database
	cfg.Timeout = time.Duration(c.ConnectTimeoutMillis) * time.Millisecond
	cfg.DialFunc = tcpDialer(c).DialContext
	return cfg
}

// PgPoolFactory is a [PoolFactory] for Postgres (pgx stdlib): opens a *sql.DB from a
// [ResolvedConnectionConfig] ([pgConnConfig]) and applies the pool SIZING (MaxOpenConns = MaxPool) +
// idle timeout AT CONSTRUCTION — the config is the sole source of the cap. Returns the
// owned-connection [Pool] adapter (checkouts bounded by ConnectTimeoutMillis) + a closer (db.Close).
// role is accepted for the reader/writer replica split (the caller may vary host per role via the
// config it passes); this factory ignores it (same params for both — a real replica split would carry
// a different host in each setup). Mirrors the TS pgPoolFactory.
func PgPoolFactory() PoolFactory {
	return func(config ResolvedConnectionConfig, _ string) (BuiltPool, error) {
		connConfig, err := pgConnConfig(config)
		if err != nil {
			return BuiltPool{}, mapSqliteError(err)
		}
		db := stdlib.OpenDB(*connConfig)
		applyPoolSizing(db, config)
		pool := NewSQLDBPool(db, config.ConnectTimeoutMillis)
		if err := pool.ping(); err != nil {
			_ = db.Close()
			return BuiltPool{}, mapSqliteError(err)
		}
		return BuiltPool{Pool: pool, Close: closeWithStmtCache(db)}, nil
	}
}

// closeWithStmtCache returns a closer that first drops db's prepared-statement cache, then closes the
// *sql.DB — so a pool teardown releases the Go-side stmt cache too (no leaked map entry / handle).
func closeWithStmtCache(db *sql.DB) func() error {
	return func() error {
		CloseDBStmtCache(db)
		return db.Close()
	}
}

// MysqlPoolFactory is a [PoolFactory] for MySQL (the RETURNING-emulating "mysql-scp" connector): opens
// a *sql.DB from a [ResolvedConnectionConfig] ([mysqlConfig]) and applies the pool SIZING
// (MaxOpenConns = MaxPool) + idle timeout AT CONSTRUCTION (the config is the sole source of the cap).
// Returns the owned-connection [Pool] adapter (checkouts bounded by ConnectTimeoutMillis — the checkout
// context reaches the handshake through the connector) + a closer. Mirrors the TS mysqlPoolFactory
// (mysql2 has no min idle floor; neither has database/sql — see [ConnectionConfig.MinPool]).
func MysqlPoolFactory() PoolFactory {
	return func(config ResolvedConnectionConfig, _ string) (BuiltPool, error) {
		connector, err := newScpMysqlConnector(mysqlConfig(config))
		if err != nil {
			return BuiltPool{}, mapSqliteError(err)
		}
		db := sql.OpenDB(connector)
		applyPoolSizing(db, config)
		pool := NewSQLDBPool(db, config.ConnectTimeoutMillis)
		if err := pool.ping(); err != nil {
			_ = db.Close()
			return BuiltPool{}, mapSqliteError(err)
		}
		return BuiltPool{Pool: pool, Close: closeWithStmtCache(db)}, nil
	}
}
