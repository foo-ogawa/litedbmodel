// Command lm_orm_native — the NATIVE-codegen ORM-bench cell (#141), Go twin of rust/orm_bench.
//
// A litedbmodel-CONSUMER: it opens this build's target DB, seeds the canonical fixture (generated_setup STATEMENTS +
// SEED, both from the orm-domain SSoT), BINDS the op-agnostic leaf transport to that connection, and
// drives the bc-GENERATED covered readers directly by their signatures — the per-dialect package is
// selected at BUILD TIME by `-tags bench_<dialect>` (target_<dialect>.go). Every SQL node
// funnels through litedbmodel_runtime.ExecuteSQL; PluckKeys/GroupChildren shape relations over the
// shared grouping CORE. The consumer holds NO SQL, NO hand-written exec seam, NO node handlers.
//
// The RETURNING-chained TRANSACTIONS run THROUGH the runtime tx boundary (WithAmbientTransaction:
// BEGIN → the .map runner's 2 body statements via the leaf → COMMIT on ok / ROLLBACK on error) — the
// consumer's tx-boundary responsibility (NOT a bc feature, NOT emitted into the generated runner).
//
// Modes:
//
//	lm_orm_native            — run all 19 covered ops once; print per-op statement-count + row-count;
//	                           assert the N+1-free relation counts + the atomic tx statement counts.
//	lm_orm_native bench      — additionally time each op over reps iterations and print a flat CSV.
package main

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"strconv"
	"sync/atomic"
	"time"

	bc "github.com/foo-ogawa/behavior-contracts/go"
	rt "github.com/foo-ogawa/litedbmodel/go/litedbmodel_runtime"
	"github.com/foo-ogawa/litedbmodel/go/lm_bench/setup"

	_ "modernc.org/sqlite" // PURE-GO sqlite driver (registered as "sqlite")
)

// openSeeded opens this build's target DB and applies the ONE seed SSoT (.setup/<dialect>.json, from
// orm-domain.ts) — schema then the canonical 110-user fixture. No hand-written schema/seed here.
//
// The target is `benchDialect`, the SAME build-tag constant that selected the generated module
// (target_<dialect>.go), so the SQL baked into that module and the DB it runs against can never
// disagree. Postgres/MySQL are opened by litedbmodel_runtime, which owns this repo's live connections
// (rt.OpenPostgres / rt.OpenMysql); the cell hand-writes no driver wiring. An unreachable DB is a LOUD
// failure — there is no sqlite fallback to silently measure the wrong thing.
func openSeeded() (*sql.DB, error) {
	doc, err := setup.Load(benchDialect)
	if err != nil {
		return nil, err
	}
	var db *sql.DB
	switch benchDialect {
	case "sqlite":
		db, err = sql.Open("sqlite", ":memory:")
		if err == nil {
			db.SetMaxOpenConns(1) // one in-memory connection so schema + seed + ops share the same DB
			db.SetMaxIdleConns(1)
		}
	case "postgres":
		db, err = rt.OpenPostgres(setup.PostgresDSN())
	case "mysql":
		db, err = rt.OpenMysql(setup.MysqlDSN())
	default:
		return nil, fmt.Errorf("unknown bench dialect %q", benchDialect)
	}
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", benchDialect, err)
	}
	for _, group := range [][]string{doc.Schema, doc.Delete, doc.Insert} {
		for _, s := range group {
			if _, err := db.Exec(s); err != nil {
				return nil, fmt.Errorf("setup %q: %w", s, err)
			}
		}
	}
	return db, nil
}

// reseed re-applies this dialect's canonical fixture between ops (as the python/php/rust cells do), so
// no op inherits the previous op's mutations. Runs on the raw connection, OFF the counted seam.
func reseed(db *sql.DB, doc setup.Doc) error {
	for _, group := range [][]string{doc.Delete, doc.Insert} {
		for _, s := range group {
			if _, err := db.Exec(s); err != nil {
				return fmt.Errorf("seed %q: %w", s, err)
			}
		}
	}
	return nil
}

// userRows builds the 10-row batch record set for createMany/upsertMany as ONE opaque `rows` wire array
// (the json_each/JSON_TABLE batch param). `stable` reuses fixed emails (upsertMany — conflict-updates);
// else the email varies by iteration so a plain INSERT stays insertable under the UNIQUE(email)
// constraint. Mirrors the rust `user_rows` / python `_user_rows` batch shape.
func userRows(it int, stable bool) []NewUser {
	rows := make([]NewUser, 10)
	for i := 0; i < 10; i++ {
		email := fmt.Sprintf("many%d_%d@bench.com", it, i)
		if stable {
			email = fmt.Sprintf("many%d@bench.com", i)
		}
		rows[i] = NewUser{Email: email, Name: fmt.Sprintf("Many %d", i)}
	}
	return rows
}

// updateManyRows builds the id-keyed 10-row batch set for updateMany (updates the seeded users 1..10).
func updateManyRows() []UserPatch {
	rows := make([]UserPatch, 10)
	for i := 1; i <= 10; i++ {
		rows[i-1] = UserPatch{Id: int64(i), Name: fmt.Sprintf("Many %d", i)}
	}
	return rows
}

// op runs ONE covered op for iteration it. Rows are NOT reported here: the row count is taken at the
// runtime seam (every row of every statement), which is the only place a relation's true 11,100-row
// traversal is visible. Fixed inputs mirror the SCP ops SSoT; mutating ops vary their
// UNIQUE column by it so a timed loop does not collide. A RETURNING-chained tx op runs THROUGH the
// runtime tx boundary (WithAmbientTransaction over the bound db) so BEGIN/COMMIT bracket the leaf's 2
// body statements on the tx-owned connection; the generated runner emits no BEGIN/COMMIT.
func op(db *sql.DB, name string, it int) error {
	switch name {
	case "findAll":
		_, err := findAll()
		return err
	case "filterPaginateSort":
		_, err := filterPaginateSort(1)
		return err
	case "findFirst":
		_, err := findFirst("User%")
		return err
	case "findUnique":
		_, err := findUnique("user500@example.com")
		return err
	case "nestedFindAll":
		_, err := nestedFindAll()
		return err
	case "nestedFindFirst":
		_, err := nestedFindFirst("User%")
		return err
	case "nestedFindUnique":
		_, err := nestedFindUnique("user1@example.com")
		return err
	case "nestedRelations":
		_, err := nestedRelations()
		return err
	case "compositeRelations":
		_, err := compositeRelations()
		return err
	case "create":
		_, err := create(fmt.Sprintf("new%d@bench.com", it), "New")
		return err
	case "update":
		_, err := update(1, "Updated 1")
		return err
	case "upsert":
		_, err := upsert("user1@example.com", "Upserted One")
		return err
	case "createMany":
		// 10 fresh rows — email is UNIQUE NOT NULL, so vary per iteration to stay insertable.
		_, err := createMany(userRows(it, false))
		return err
	case "upsertMany":
		// 10 rows keyed on email (ON CONFLICT DO UPDATE) — idempotent across iterations.
		_, err := upsertMany(userRows(it, true))
		return err
	case "updateMany":
		// 10 rows keyed on id (1..10) — updates the seeded users.
		_, err := updateMany(updateManyRows())
		return err
	case "nestedCreate":
		// Fresh user per iteration (email is UNIQUE) → INSERT user RETURNING id → INSERT post (author_id).
		err := rt.WithAmbientTransaction(db, func() error {
			_, e := nestedCreate(fmt.Sprintf("nc%d@bench.com", it), "NC", "NC Post")
			return e
		})
		return err
	case "nestedUpsert":
		// Existing email (ON CONFLICT DO UPDATE) → INSERT post keyed on the upserted user's id.
		err := rt.WithAmbientTransaction(db, func() error {
			_, e := nestedUpsert("user1@example.com", "NUp", "NUp Post")
			return e
		})
		return err
	case "nestedUpdate":
		// UPDATE seeded user 1 RETURNING id → UPDATE that user's posts.
		err := rt.WithAmbientTransaction(db, func() error {
			_, e := nestedUpdate(1, "NU", "NU Post")
			return e
		})
		return err
	case "delete":
		// Create-then-delete: INSERT a fresh user RETURNING id → DELETE the exact created row by id.
		err := rt.WithAmbientTransaction(db, func() error {
			_, e := delete(fmt.Sprintf("del%d@bench.com", it), "Del")
			return e
		})
		return err
	default:
		return fmt.Errorf("unknown op %q", name)
	}
}

var ops = []string{
	"findAll", "filterPaginateSort", "findFirst", "findUnique",
	"nestedFindAll", "nestedFindFirst", "nestedFindUnique", "nestedRelations", "compositeRelations",
	"create", "update", "upsert",
	"createMany", "upsertMany", "updateMany",
	"nestedCreate", "nestedUpsert", "nestedUpdate", "delete",
}

// expectedStatements is the per-op statement count observed at the runtime seam (every read / write /
// tx-control BEGIN/COMMIT funnels through Execute/Run → middleware; Pluck/Group are in-memory and do
// NOT count). Relations prove 1 parent + 1 batched child per level (N+1-free) regardless of parent
// fan-out; batch writes are ONE statement; a RETURNING-chained tx is BEGIN + 2 body + COMMIT = 4.
var expectedStatements = map[string]int{
	"findAll": 1, "filterPaginateSort": 1, "findFirst": 1, "findUnique": 1,
	"nestedFindAll": 2, "nestedFindFirst": 2, "nestedFindUnique": 2, "nestedRelations": 3, "compositeRelations": 3,
	"create": 1, "update": 1, "upsert": 1,
	"createMany": 1, "upsertMany": 1, "updateMany": 1,
	"nestedCreate": 4, "nestedUpsert": 4, "nestedUpdate": 4, "delete": 4,
}

// txOps names the RETURNING-chained transactions (their count is BEGIN + 2 body + COMMIT statements,
// not plain queries) — used only to label the safety print.
var txOps = map[string]bool{"nestedCreate": true, "nestedUpsert": true, "nestedUpdate": true, "delete": true}

func main() {
	doBench := len(os.Args) > 1 && os.Args[1] == "bench"

	db, err := openSeeded()
	if err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: seed: %v\n", err)
		os.Exit(1)
	}
	defer db.Close()
	rt.BindLeafTransport(db, benchDialect)
	defer rt.UnbindLeafTransport()

	// The N+1-avoidance / atomic-tx safety proof: a seam middleware counts EVERY statement that funnels
	// through Execute/Run (reads + writes + tx-control BEGIN/COMMIT) — the SAME lens the python/php cells
	// use. The bound leaf ctx resolves the process-global registry, so a global registration is seen.
	var stmtCount int64
	var rowCount int64
	counter := rt.NewMiddleware(rt.MiddlewareConfig{
		Execute: func(_ any, next rt.ExecNext, sqlText string, args []any) (any, error) {
			atomic.AddInt64(&stmtCount, 1)
			out, err := next(sqlText, args)
			// The read seam hands back `[]bc.Value` (the write seam a run summary, which adds nothing), so
			// this ONE hook also totals the rows the op moved — the report's per-row denominator (#170).
			if rows, ok := out.([]bc.Value); ok {
				atomic.AddInt64(&rowCount, int64(len(rows)))
			}
			return out, err
		},
	})
	unregister := rt.RegisterMiddleware(context.Background(), counter.Descriptor())
	defer unregister()

	fmt.Println("op                    statements  rows")
	doc, err := setup.Load(benchDialect)
	if err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: setup: %v\n", err)
		os.Exit(1)
	}
	fail := 0
	for _, name := range ops {
		if err := reseed(db, doc); err != nil {
			fmt.Fprintf(os.Stderr, "FATAL: %v\n", err)
			os.Exit(1)
		}
		atomic.StoreInt64(&stmtCount, 0)
		atomic.StoreInt64(&rowCount, 0)
		if err := op(db, name, 0); err != nil {
			fmt.Printf("%-20s  ERR: %v\n", name, err)
			fail++
			continue
		}
		q := int(atomic.LoadInt64(&stmtCount))
		// Rows as counted at the seam — every row of every statement, not the terminal slice length (a
		// relation's terminal holds 100 parents while the op moved 11,100 rows).
		rows := int(atomic.LoadInt64(&rowCount))
		mark := "ok"
		if exp, ok := expectedStatements[name]; ok && exp != q {
			mark = fmt.Sprintf("STATEMENT-COUNT MISMATCH (want %d)", exp)
			fail++
		}
		kind := ""
		if txOps[name] {
			kind = " (BEGIN + 2 body + COMMIT)"
		}
		fmt.Printf("%-20s  %-10d  %-5d %s%s\n", name, q, rows, mark, kind)
	}

	if doBench {
		reps := 200
		warmup := 30
		if len(os.Args) > 2 {
			if n, e := strconv.Atoi(os.Args[2]); e == nil {
				reps = n
			}
		}
		if len(os.Args) > 3 {
			if n, e := strconv.Atoi(os.Args[3]); e == nil {
				warmup = n
			}
		}
		fmt.Println("\ncell,dialect,op,iter,us,rows")
		for _, name := range ops {
			if err := reseed(db, doc); err != nil {
				fmt.Fprintf(os.Stderr, "FATAL: %v\n", err)
				os.Exit(1)
			}
			for it := 0; it < warmup; it++ {
				if err := op(db, name, it+1); err != nil {
					fmt.Fprintf(os.Stderr, "warmup %s: %v\n", name, err)
					os.Exit(1)
				}
			}
			for it := 0; it < reps; it++ {
				g := it + warmup + 1
				// Reset OUTSIDE the timed region: rows are measured per iteration, and the report divides
				// the latency by them (#170).
				atomic.StoreInt64(&rowCount, 0)
				t := time.Now()
				if err := op(db, name, g); err != nil {
					fmt.Fprintf(os.Stderr, "bench %s: %v\n", name, err)
					os.Exit(1)
				}
				us := time.Since(t).Microseconds()
				fmt.Printf("native,%s,%s,%d,%d,%d\n", benchDialect, name, it, us, atomic.LoadInt64(&rowCount))
			}
		}
	}

	if fail > 0 {
		fmt.Fprintf(os.Stderr, "\nFAILED: %d op(s) errored or mismatched.\n", fail)
		os.Exit(1)
	}
	fmt.Println("\nOK: all 19 covered ops ran green; relation counts are N+1-free; tx counts are atomic (BEGIN+2 body+COMMIT).")
}
