// LIVE-DB concurrency tests for the bc-generated Go entries (#315): many goroutines calling the
// generated `Posts` / `CreatePost` at the same time, the way a Go HTTP server calls them, against real
// PostgreSQL and MySQL.
//
// A generated entry reaches its connection only through the context it is called with
// (litedbmodel_runtime.BindLeafTransport / WithAmbientTransaction), so what these assert is that
// concurrent requests never share one: concurrent transactions hold distinct connections and do not
// see each other's uncommitted rows, a statement outside any transaction never runs on another
// goroutine's transaction connection, and writer-sticky after a commit routes only the committing
// request's reads to the writer.
//
// The schema is the live-DB corpus's (the tables the generated SQL targets). Gated behind
// LITEDBMODEL_TX_ISOLATION=1 like the other live legs:
//
//	docker compose -f docker-compose.test.yml -f docker-compose.livedb.yml up -d postgres mysql
//	LITEDBMODEL_TX_ISOLATION=1 go test -race ./conformance/livedb/ -run Concurrent -v
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	rt "github.com/foo-ogawa/litedbmodel/go/v2/litedbmodel_runtime"

	my "github.com/foo-ogawa/litedbmodel/go/v2/conformance/gen/mysql"
	pg "github.com/foo-ogawa/litedbmodel/go/v2/conformance/gen/postgres"
)

// liveDialect is one server the concurrency legs run against: how to reach it, the two generated
// entries they drive, and — where the test user may read it — the server's own count of open
// transactions ("" where it may not: MySQL's innodb_trx needs the PROCESS privilege).
type liveDialect struct {
	name       string
	open       func(t *testing.T) *sql.DB
	openRepl   func(t *testing.T, writer *sql.DB) *sql.DB
	posts      func(ctx context.Context, authorID int64) (int, error)
	createPost func(ctx context.Context, id, authorID int64) error
	openTxs    string
}

func liveDialects() []liveDialect {
	return []liveDialect{
		{
			name: "postgres",
			open: func(t *testing.T) *sql.DB { return openLive(t, rt.OpenPostgres, pgDSN()) },
			// A reader that never receives the writes: the corpus tables in a schema of their own,
			// reached through the connection's search_path.
			openRepl: func(t *testing.T, writer *sql.DB) *sql.DB {
				if _, err := writer.Exec("CREATE SCHEMA IF NOT EXISTS go_concurrency_replica"); err != nil {
					t.Fatalf("replica schema: %v", err)
				}
				return openLive(t, rt.OpenPostgres, pgDSN()+"&search_path=go_concurrency_replica")
			},
			posts: func(ctx context.Context, authorID int64) (int, error) {
				rows, err := pg.Posts(ctx, authorID)
				return len(rows), err
			},
			createPost: func(ctx context.Context, id, authorID int64) error {
				_, err := pg.CreatePost(ctx, id, authorID, "concurrent", "live", "2026-10-25")
				return err
			},
			openTxs: "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction'",
		},
		{
			name: "mysql",
			open: func(t *testing.T) *sql.DB { return openLive(t, rt.OpenMysql, mysqlDSN()) },
			// A reader that never receives the writes: the corpus tables in a database of their own.
			openRepl: func(t *testing.T, writer *sql.DB) *sql.DB {
				if _, err := writer.Exec("CREATE DATABASE IF NOT EXISTS scp_go_replica"); err != nil {
					t.Fatalf("replica database: %v", err)
				}
				return openLive(t, rt.OpenMysql, mysqlDSNOn("scp_go_replica"))
			},
			posts: func(ctx context.Context, authorID int64) (int, error) {
				rows, err := my.Posts(ctx, authorID)
				return len(rows), err
			},
			createPost: func(ctx context.Context, id, authorID int64) error {
				_, err := my.CreatePost(ctx, id, authorID, "concurrent", "live", "2026-10-25")
				return err
			},
			openTxs: "",
		},
	}
}

// concurrency is how many requests run at once: enough that a shared connection or a shared sticky
// stamp is hit by nearly every interleaving, well under both servers' connection limits.
const concurrency = 16

func concurrencyGated(t *testing.T) {
	t.Helper()
	if os.Getenv("LITEDBMODEL_TX_ISOLATION") != "1" {
		t.Skip("skipped (set LITEDBMODEL_TX_ISOLATION=1 + docker up: PG:5433 + MySQL:3307)")
	}
}

func openLive(t *testing.T, open func(string) (*sql.DB, error), dsn string) *sql.DB {
	t.Helper()
	db, err := open(dsn)
	if err != nil {
		t.Fatalf("connect (docker up?): %v", err)
	}
	db.SetMaxOpenConns(concurrency * 2)
	t.Cleanup(func() { _ = db.Close() })
	return db
}

// seedCorpusSchema (re)creates the live-DB corpus tables + seed rows on db.
func seedCorpusSchema(t *testing.T, db *sql.DB) {
	t.Helper()
	data, err := os.ReadFile("../../../conformance/vectors-livedb/livedb.json")
	if err != nil {
		t.Fatalf("corpus: %v", err)
	}
	var corpus corpusT
	if err := json.Unmarshal(data, &corpus); err != nil {
		t.Fatalf("corpus: %v", err)
	}
	if err := applySchema(db, corpus.Schema); err != nil {
		t.Fatalf("schema: %v", err)
	}
}

// rendezvous holds n goroutines until all have arrived. A goroutine that fails calls abort, so the
// others are released instead of waiting forever inside an open transaction.
type rendezvous struct {
	mu    sync.Mutex
	left  int
	all   chan struct{}
	abort chan struct{}
	once  sync.Once
}

func newRendezvous(n int) *rendezvous {
	return &rendezvous{left: n, all: make(chan struct{}), abort: make(chan struct{})}
}

var errAborted = errors.New("another goroutine failed")

func (r *rendezvous) arrive() error {
	r.mu.Lock()
	r.left--
	if r.left == 0 {
		close(r.all)
	}
	r.mu.Unlock()
	select {
	case <-r.all:
		return nil
	case <-r.abort:
		return errAborted
	case <-time.After(30 * time.Second):
		return errors.New("rendezvous timed out")
	}
}

func (r *rendezvous) fail() { r.once.Do(func() { close(r.abort) }) }

// countOpenTransactions asserts the server reports `want` sessions idle in an open transaction. The
// goroutines holding them are parked, but the last one's backend may not have reported its idle state
// yet when it is released into the wait, so the count is re-read for a short while; sessions that
// share a connection never reach `want`.
func countOpenTransactions(t *testing.T, db *sql.DB, query string, want int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var open int
		if err := db.QueryRow(query).Scan(&open); err != nil {
			t.Errorf("open transactions: %v", err)
			return
		}
		if open >= want {
			return
		}
		if time.Now().After(deadline) {
			t.Errorf("server reports %d open transactions while %d goroutines each hold one — they share connections", open, want)
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// request is one request's context for the generated entries: its own ExecutionContext over db.
func request(db *sql.DB, dialect string) context.Context {
	return rt.BindLeafTransport(rt.ContextForDBCtx(context.Background(), db), dialect)
}

// Every goroutine opens a transaction, writes a row under its own author and reads it back, then all
// of them wait with the transaction OPEN. At that point the server must report one open transaction
// per goroutine (distinct connections), and no goroutine may see another's uncommitted row. Half of
// them then roll back: exactly the committed half's rows remain.
func TestConcurrentTransactionsAreIsolatedLive(t *testing.T) {
	concurrencyGated(t)
	for _, d := range liveDialects() {
		t.Run(d.name, func(t *testing.T) {
			db := d.open(t)
			seedCorpusSchema(t, db)
			allOpen := newRendezvous(concurrency)
			counted := make(chan struct{}) // closed once the open transactions have been counted
			checked := newRendezvous(concurrency)
			rollback := errors.New("roll this one back")
			author := func(i int) int64 { return int64(1000 + i) }

			var wg sync.WaitGroup
			for i := 0; i < concurrency; i++ {
				wg.Add(1)
				go func(i int) {
					defer wg.Done()
					err := rt.WithAmbientTransaction(request(db, d.name), func(txCtx context.Context) error {
						if err := d.createPost(txCtx, int64(5000+i), author(i)); err != nil {
							return err
						}
						if n, err := d.posts(txCtx, author(i)); err != nil || n != 1 {
							return fmt.Errorf("own uncommitted row: n=%d err=%v, want 1", n, err)
						}
						if err := allOpen.arrive(); err != nil {
							return err
						}
						// Stay idle in the transaction until it has been counted.
						<-counted
						for j := 0; j < concurrency; j++ {
							if j == i {
								continue
							}
							if n, err := d.posts(txCtx, author(j)); err != nil || n != 0 {
								return fmt.Errorf("goroutine %d sees goroutine %d's uncommitted row: n=%d err=%v", i, j, n, err)
							}
						}
						if err := checked.arrive(); err != nil {
							return err
						}
						if i%2 == 1 {
							return rollback
						}
						return nil
					})
					if err != nil && !(i%2 == 1 && errors.Is(err, rollback)) {
						allOpen.fail()
						checked.fail()
						t.Errorf("goroutine %d: %v", i, err)
					}
				}(i)
			}

			// While every goroutine holds its transaction open, the server sees that many of them. (Where the
			// count is not readable, the visibility checks above carry the same fact: a goroutine sees its
			// own uncommitted row and no other's only if each runs in a session of its own.)
			select {
			case <-allOpen.all:
				if d.openTxs != "" {
					countOpenTransactions(t, db, d.openTxs, concurrency)
				}
			case <-allOpen.abort:
			}
			close(counted)
			wg.Wait()
			if t.Failed() {
				return
			}

			after := request(db, d.name)
			for i := 0; i < concurrency; i++ {
				want := 1 - i%2
				if n, err := d.posts(after, author(i)); err != nil || n != want {
					t.Errorf("after the transactions: author %d has %d rows (err %v), want %d", author(i), n, err, want)
				}
			}
		})
	}
}

// One goroutine holds a transaction with an uncommitted row and then rolls it back. Meanwhile other
// goroutines, with no transaction, read that author and write rows of their own. Running on the
// transaction's connection would show them the uncommitted row and take their writes down with the
// rollback; on their own connections they see nothing and their rows survive.
func TestConcurrentNonTransactionalStatementsStayOffOtherTransactionsLive(t *testing.T) {
	concurrencyGated(t)
	for _, d := range liveDialects() {
		t.Run(d.name, func(t *testing.T) {
			db := d.open(t)
			seedCorpusSchema(t, db)
			const txAuthor = 2000
			inside := make(chan struct{})
			done := newRendezvous(concurrency)
			rollback := errors.New("roll back")

			var wg sync.WaitGroup
			wg.Add(1)
			go func() {
				defer wg.Done()
				err := rt.WithAmbientTransaction(request(db, d.name), func(txCtx context.Context) error {
					if err := d.createPost(txCtx, 6000, txAuthor); err != nil {
						close(inside)
						return err
					}
					close(inside)
					// Hold the transaction open until every other goroutine has finished.
					if err := done.arrive(); err != nil {
						return err
					}
					return rollback
				})
				if !errors.Is(err, rollback) {
					done.fail()
					t.Errorf("transaction: %v", err)
				}
			}()
			for k := 1; k < concurrency; k++ {
				wg.Add(1)
				go func(k int) {
					defer wg.Done()
					<-inside
					ctx := request(db, d.name)
					for round := 0; round < 5; round++ {
						if n, err := d.posts(ctx, txAuthor); err != nil || n != 0 {
							done.fail()
							t.Errorf("goroutine %d (no transaction) sees the open transaction's row: n=%d err=%v", k, n, err)
							return
						}
					}
					if err := d.createPost(ctx, int64(7000+k), int64(txAuthor+k)); err != nil {
						done.fail()
						t.Errorf("goroutine %d write: %v", k, err)
						return
					}
					if err := done.arrive(); err != nil {
						t.Errorf("goroutine %d: %v", k, err)
					}
				}(k)
			}
			wg.Wait()
			if t.Failed() {
				return
			}

			after := request(db, d.name)
			if n, err := d.posts(after, txAuthor); err != nil || n != 0 {
				t.Errorf("rolled-back row: n=%d err=%v, want 0", n, err)
			}
			for k := 1; k < concurrency; k++ {
				if n, err := d.posts(after, int64(txAuthor+k)); err != nil || n != 1 {
					t.Errorf("goroutine %d's own write after the other transaction rolled back: n=%d err=%v, want 1", k, n, err)
				}
			}
		})
	}
}

// Reader/writer routing with a reader that never receives the writes, so where a read went shows in
// what it returns. One request commits a row and keeps reading it: writer-sticky sends those reads to
// the writer, so the row is there. Concurrent requests read the same author at the same time: they did
// not write, so they stay on the reader and the row is not there.
func TestConcurrentWriterStickyIsPerRequestLive(t *testing.T) {
	concurrencyGated(t)
	for _, d := range liveDialects() {
		t.Run(d.name, func(t *testing.T) {
			writer := d.open(t)
			seedCorpusSchema(t, writer)
			replica := d.openRepl(t, writer)
			seedCorpusSchema(t, replica)
			routing := rt.RoutingConfig{
				Registry: rt.NewConnectionRegistry(map[string]rt.ReaderWriterPools{
					rt.DefaultConnection: rt.ReaderWriterPair(rt.NewSQLDBPool(replica), rt.NewSQLDBPool(writer)),
				}),
				Sticky: rt.NewWriterStickyClock(rt.StickyOptions{}),
			}
			routedRequest := func() context.Context {
				return rt.BindLeafTransport(rt.ContextForRoutingCtx(context.Background(), routing), d.name)
			}
			const author = 3000
			committed := make(chan struct{})

			var wg sync.WaitGroup
			wg.Add(1)
			go func() {
				defer wg.Done()
				defer func() {
					select {
					case <-committed:
					default:
						close(committed)
					}
				}()
				ctx := routedRequest()
				if n, err := d.posts(ctx, author); err != nil || n != 0 {
					t.Errorf("before the commit: n=%d err=%v, want 0", n, err)
					return
				}
				if err := rt.WithAmbientTransaction(ctx, func(txCtx context.Context) error {
					return d.createPost(txCtx, 8000, author)
				}); err != nil {
					t.Errorf("commit: %v", err)
					return
				}
				close(committed)
				for round := 0; round < 20; round++ {
					if n, err := d.posts(ctx, author); err != nil || n != 1 {
						t.Errorf("the committing request's read %d: n=%d err=%v, want 1 (the writer)", round, n, err)
						return
					}
				}
			}()
			for k := 1; k < concurrency; k++ {
				wg.Add(1)
				go func(k int) {
					defer wg.Done()
					<-committed
					ctx := routedRequest()
					for round := 0; round < 20; round++ {
						if n, err := d.posts(ctx, author); err != nil || n != 0 {
							t.Errorf("request %d (no commit) read %d: n=%d err=%v, want 0 (the reader)", k, round, n, err)
							return
						}
					}
				}(k)
			}
			wg.Wait()
		})
	}
}
