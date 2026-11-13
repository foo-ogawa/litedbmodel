// LIVE-DB: a transaction retry after a connection error runs only on a connection that passed a
// `SELECT 1` probe ([ExecutionContext.acquireTxConnection]). Every connection of the pool is killed by a
// separate admin connection (pg_terminate_backend / KILL, by the ids of that pool's own connections) while
// a loopback proxy keeps the client sockets open, as a load balancer or a failover does: database/sql
// still holds them and learns they are dead only by using them. Transaction() then commits once.
//
// Gated behind LITEDBMODEL_TX_ISOLATION=1 (the tx_boundary_livedb suite's gate). Requires the dockerized
// PG (:5433) + MySQL (:3307).

package litedbmodel_runtime

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"net"
	"sync"
	"testing"
	"time"

	bc "github.com/foo-ogawa/behavior-contracts/go"
)

// staleProxy forwards TCP to `upstream`. stale() turns every connection open at that moment into a dead
// one the client cannot see: nothing more is forwarded to the client, and the client's next write closes
// its socket. Connections opened later are forwarded normally.
type staleProxy struct {
	ln    net.Listener
	mu    sync.Mutex
	pairs map[*stalePair]struct{}
}

type stalePair struct {
	client, upstream net.Conn
	mu               sync.Mutex
	dead             bool
}

func (p *stalePair) isDead() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.dead
}

func newStaleProxy(t *testing.T, upstream string) *staleProxy {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("proxy listen: %v", err)
	}
	p := &staleProxy{ln: ln, pairs: map[*stalePair]struct{}{}}
	go func() {
		for {
			client, err := ln.Accept()
			if err != nil {
				return
			}
			up, err := net.Dial("tcp", upstream)
			if err != nil {
				_ = client.Close()
				continue
			}
			pair := &stalePair{client: client, upstream: up}
			p.mu.Lock()
			p.pairs[pair] = struct{}{}
			p.mu.Unlock()
			go func() { // client → upstream; a write on a dead pair closes the client
				buf := make([]byte, 32*1024)
				for {
					n, err := client.Read(buf)
					if n > 0 {
						if pair.isDead() {
							break
						}
						if _, werr := up.Write(buf[:n]); werr != nil {
							break
						}
					}
					if err != nil {
						break
					}
				}
				_ = client.Close()
				_ = up.Close()
			}()
			go func() { // upstream → client, until the pair is dead
				buf := make([]byte, 32*1024)
				for {
					n, err := up.Read(buf)
					if pair.isDead() {
						return // the client is not told
					}
					if n > 0 {
						if _, werr := client.Write(buf[:n]); werr != nil {
							return
						}
					}
					if err != nil {
						if err == io.EOF && !pair.isDead() {
							_ = client.Close()
						}
						return
					}
				}
			}()
		}
	}()
	return p
}

func (p *staleProxy) addr() string { return p.ln.Addr().String() }

func (p *staleProxy) stale() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for pair := range p.pairs {
		pair.mu.Lock()
		pair.dead = true
		pair.mu.Unlock()
	}
}

func (p *staleProxy) close() {
	_ = p.ln.Close()
	p.mu.Lock()
	defer p.mu.Unlock()
	for pair := range p.pairs {
		_ = pair.client.Close()
		_ = pair.upstream.Close()
	}
}

const killedPoolSize = 3 // = the default RetryLimit: every connection the pool holds is dead after the kill

// poolIDs checks out killedPoolSize connections at once, reads each one's server-side id and returns them
// all to the pool — twice, so every connection was in use within the last second, as on a busy server (pgx
// pings a connection idle for over a second when it is checked out, and would find it dead by itself).
func poolIDs(t *testing.T, db *sql.DB, idSQL string) []int64 {
	t.Helper()
	var ids []int64
	for round := 0; round < 2; round++ {
		conns := make([]*sql.Conn, 0, killedPoolSize)
		ids = make([]int64, 0, killedPoolSize)
		for i := 0; i < killedPoolSize; i++ {
			c, err := db.Conn(context.Background())
			if err != nil {
				t.Fatalf("checkout: %v", err)
			}
			var id int64
			if err := c.QueryRowContext(context.Background(), idSQL).Scan(&id); err != nil {
				t.Fatalf("connection id: %v", err)
			}
			conns = append(conns, c)
			ids = append(ids, id)
		}
		for _, c := range conns {
			_ = c.Close()
		}
	}
	return ids
}

func txRetryAfterKilledPool(t *testing.T, dialect string, open func(addr string) (*sql.DB, error), upstream string, admin *sql.DB, idSQL, killSQL, createSQL, insertSQL string) {
	tbl := fmt.Sprintf("conn_retry_go_%s", dialect)
	if _, err := admin.Exec("DROP TABLE IF EXISTS " + tbl); err != nil {
		t.Fatalf("drop: %v", err)
	}
	if _, err := admin.Exec(fmt.Sprintf(createSQL, tbl)); err != nil {
		t.Fatalf("create: %v", err)
	}
	defer func() { _, _ = admin.Exec("DROP TABLE IF EXISTS " + tbl) }()

	proxy := newStaleProxy(t, upstream)
	defer proxy.close()
	db, err := open(proxy.addr())
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(killedPoolSize)
	db.SetMaxIdleConns(killedPoolSize)

	ids := poolIDs(t, db, idSQL)
	proxy.stale()
	for _, id := range ids {
		if _, err := admin.Exec(fmt.Sprintf(killSQL, id)); err != nil {
			t.Fatalf("kill %d: %v", id, err)
		}
	}

	opts := DefaultTransactionOptions()
	opts.RetryDurationMs = 1
	_, err = Transaction(ContextForDB(db), dialect, opts, func(txCtx *ExecutionContext) (int, error) {
		_, e := Run(txCtx, fmt.Sprintf(insertSQL, tbl), []any{"after-kill"}, WriteIntent())
		return 0, e
	})
	if err != nil {
		t.Fatalf("%s: Transaction after the pool's connections were killed: %v", dialect, err)
	}
	var n int
	if err := admin.QueryRow("SELECT count(*) FROM " + tbl).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 1 {
		t.Fatalf("%s: committed rows = %d, want 1", dialect, n)
	}
}

func TestTxRetryAfterKilledPoolLivePG(t *testing.T) {
	if !txIsoEnabled() {
		t.Skip("skipped (set LITEDBMODEL_TX_ISOLATION=1 + docker up)")
	}
	admin := openPgIso(t)
	defer admin.Close()
	upstream := net.JoinHostPort(envOr("TEST_DB_HOST", "localhost"), envOr("TEST_DB_PORT", "5433"))
	open := func(addr string) (*sql.DB, error) {
		return OpenPostgres(fmt.Sprintf("postgres://%s:%s@%s/%s?sslmode=disable",
			envOr("TEST_DB_USER", "testuser"), envOr("TEST_DB_PASSWORD", "testpass"), addr, envOr("TEST_DB_NAME", "testdb")))
	}
	txRetryAfterKilledPool(t, "postgres", open, upstream, admin,
		"SELECT pg_backend_pid()", "SELECT pg_terminate_backend(%d)",
		"CREATE TABLE %s (id serial PRIMARY KEY, label text NOT NULL)", "INSERT INTO %s (label) VALUES ($1)")
}

func TestTxRetryAfterKilledPoolLiveMySQL(t *testing.T) {
	if !txIsoEnabled() {
		t.Skip("skipped (set LITEDBMODEL_TX_ISOLATION=1 + docker up)")
	}
	dsn := func(addr string) string {
		return fmt.Sprintf("%s:%s@tcp(%s)/%s", envOr("TEST_MYSQL_USER", "testuser"), envOr("TEST_MYSQL_PASSWORD", "testpass"), addr, envOr("TEST_MYSQL_DB", "testdb"))
	}
	upstream := net.JoinHostPort(envOr("TEST_MYSQL_HOST", "127.0.0.1"), envOr("TEST_MYSQL_PORT", "3307"))
	admin, err := OpenMysql(dsn(upstream))
	if err != nil {
		t.Fatalf("mysql admin: %v", err)
	}
	defer admin.Close()
	txRetryAfterKilledPool(t, "mysql", func(addr string) (*sql.DB, error) { return OpenMysql(dsn(addr)) }, upstream, admin,
		"SELECT CONNECTION_ID()", "KILL %d",
		"CREATE TABLE %s (id int AUTO_INCREMENT PRIMARY KEY, label varchar(32) NOT NULL)", "INSERT INTO %s (label) VALUES (?)")
}

// A REAL pg_terminate_backend on the transaction's own connection, with no proxy: the server answers the
// statement in flight with `FATAL 57P01 terminating connection due to administrator command` and closes the
// connection — what a restart or a failover sends. That is a connection error ([IsConnectionError]), so the
// transaction is retried on another connection and commits once.
func TestTxRetryAfterAdminShutdownLivePG(t *testing.T) {
	if !txIsoEnabled() {
		t.Skip("skipped (set LITEDBMODEL_TX_ISOLATION=1 + docker up)")
	}
	admin := openPgIso(t)
	defer admin.Close()
	db := openPgIso(t)
	defer db.Close()
	const tbl = "conn_retry_go_admin_shutdown"
	if _, err := admin.Exec("DROP TABLE IF EXISTS " + tbl); err != nil {
		t.Fatalf("drop: %v", err)
	}
	if _, err := admin.Exec("CREATE TABLE " + tbl + " (id serial PRIMARY KEY, label text NOT NULL)"); err != nil {
		t.Fatalf("create: %v", err)
	}
	defer func() { _, _ = admin.Exec("DROP TABLE IF EXISTS " + tbl) }()

	opts := DefaultTransactionOptions()
	opts.RetryDurationMs = 1
	attempts := 0
	_, err := Transaction(ContextForDB(db), "postgres", opts, func(txCtx *ExecutionContext) (int, error) {
		attempts++
		if attempts == 1 {
			rows, e := Execute(txCtx, "SELECT pg_backend_pid() AS id", nil, ReadIntent())
			if e != nil {
				return 0, e
			}
			pid := cellInt(rows[0].(*bc.Obj), "id")
			// Terminate this connection while a statement is in flight on it.
			go func() {
				time.Sleep(200 * time.Millisecond)
				_, _ = admin.Exec(fmt.Sprintf("SELECT pg_terminate_backend(%d)", pid))
			}()
			if _, e := Execute(txCtx, "SELECT pg_sleep(5)", nil, ReadIntent()); e != nil {
				return 0, e
			}
		}
		_, e := Run(txCtx, "INSERT INTO "+tbl+" (label) VALUES ($1)", []any{"after-admin-shutdown"}, WriteIntent())
		return 0, e
	})
	if err != nil {
		t.Fatalf("Transaction after the server terminated its connection: %v", err)
	}
	if attempts != 2 {
		t.Fatalf("attempts = %d, want 2", attempts)
	}
	var n int
	if err := admin.QueryRow("SELECT count(*) FROM " + tbl).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 1 {
		t.Fatalf("committed rows = %d, want 1", n)
	}
}
