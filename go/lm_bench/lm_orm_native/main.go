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
//	lm_orm_native sql        — capture the SQL each op issues at the runtime seam and merge it into
//	                           .setup/<dialect>.json as `ops`. The SDK baselines execute THOSE
//	                           statements, so the two surfaces cannot issue different SQL (#172). The
//	                           final text is only knowable here: PostgreSQL's relation predicates carry
//	                           a cast token the runtime resolves from the key param's element type.
package main

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"regexp"
	"runtime/pprof"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	bc "github.com/foo-ogawa/behavior-contracts/go"
	rt "github.com/foo-ogawa/litedbmodel/go/v3/litedbmodel_runtime"
	"github.com/foo-ogawa/litedbmodel/go/v3/lm_bench/setup"

	_ "modernc.org/sqlite" // PURE-GO sqlite driver (registered as "sqlite")
)

// txControl matches the tx-control statements the RUNTIME issues around a transaction op.
var txControl = regexp.MustCompile(`(?i)^\s*(BEGIN|COMMIT|ROLLBACK|START TRANSACTION)`)

// dollarPlaceholder matches PostgreSQL's `$N` bind marker.
var dollarPlaceholder = regexp.MustCompile(`\$\d+`)

// canonicalPlaceholders restores the `?` the authored SQL declares. `?`→`$N` is the RUNTIME's final
// one-pass over the fixed SQL (it cannot happen earlier: a SKIP fragment changes the shape, so the
// numbering is only knowable once the statement is assembled), and the seam sits after it. The artifact
// must carry the canonical form so each cell renders for its own driver — psycopg binds `%s`, PDO binds
// `?`, pg and pgx bind `$N`. The runtime's OTHER finalizations are kept: the resolved
// `@@PG_ARRAY_CAST@@` is genuinely only knowable at execution, from the key param's element type.
func canonicalPlaceholders(sql string) string {
	if benchDialect != "postgres" {
		return sql
	}
	// `$` also occurs inside JSON paths (`'$[0]'`), which the `\$\d+` form does not match.
	return dollarPlaceholder.ReplaceAllString(sql, "?")
}

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

// newUsers / userPatches map the DECLARED batch records (.setup/<dialect>.json `inputs`, from the axis
// SSoT) onto the record types the generated signatures take. This mapping is the only thing the go
// harness contributes: the values themselves come from the artifact every cell reads, so the go native
// cell and its SDK twin write the same ten records.
func newUsers(in setup.Values) []NewUser {
	records := in.Records("rows")
	rows := make([]NewUser, len(records))
	for i, r := range records {
		rows[i] = NewUser{Email: r.Str("email"), Name: r.Str("name")}
	}
	return rows
}

func userPatches(in setup.Values) []UserPatch {
	records := in.Records("rows")
	rows := make([]UserPatch, len(records))
	for i, r := range records {
		rows[i] = UserPatch{Id: r.Int("id"), Name: r.Str("name")}
	}
	return rows
}

// op runs ONE covered op for iteration it. Rows are NOT reported here: the row count is taken at the
// runtime seam (every row of every statement), which is the only place a relation's true 11,100-row
// traversal is visible. Fixed inputs mirror the SCP ops SSoT; mutating ops vary their
// UNIQUE column by it so a timed loop does not collide. A RETURNING-chained tx op runs THROUGH the
// runtime tx boundary (WithAmbientTransaction on the BOUND ctx) so BEGIN/COMMIT bracket the leaf's 2
// body statements on the tx-owned connection; the generated runner emits no BEGIN/COMMIT.
func op(doc setup.Doc, name string, it int) error {
	in := doc.Input(name, it)
	switch name {
	case "findAll":
		_, err := findAll()
		return err
	case "filterPaginateSort":
		_, err := filterPaginateSort(in.Int("published"))
		return err
	case "findFirst":
		_, err := findFirst(in.Str("name"))
		return err
	case "findUnique":
		_, err := findUnique(in.Str("email"))
		return err
	case "nestedFindAll":
		_, err := nestedFindAll()
		return err
	case "nestedFindFirst":
		_, err := nestedFindFirst(in.Str("name"))
		return err
	case "nestedFindUnique":
		_, err := nestedFindUnique(in.Str("email"))
		return err
	case "nestedRelations":
		_, err := nestedRelations()
		return err
	case "compositeRelations":
		_, err := compositeRelations()
		return err
	case "create":
		_, err := create(in.Str("email"), in.Str("name"))
		return err
	case "update":
		_, err := update(in.Int("id"), in.Str("name"))
		return err
	case "upsert":
		_, err := upsert(in.Str("email"), in.Str("name"))
		return err
	case "createMany":
		// 10 fresh rows — email is UNIQUE NOT NULL, so the declared email varies by iteration.
		_, err := createMany(newUsers(in))
		return err
	case "upsertMany":
		// 10 rows keyed on email (ON CONFLICT DO UPDATE) — idempotent across iterations.
		_, err := upsertMany(newUsers(in))
		return err
	case "updateMany":
		// 10 rows keyed on id (1..10) — updates the seeded users.
		_, err := updateMany(userPatches(in))
		return err
	case "nestedCreate":
		// Fresh user per iteration (email is UNIQUE) → INSERT user RETURNING id → INSERT post (author_id).
		err := rt.WithAmbientTransaction(func() error {
			_, e := nestedCreate(in.Str("email"), in.Str("name"), in.Str("title"))
			return e
		})
		return err
	case "nestedUpsert":
		// Existing email (ON CONFLICT DO UPDATE) → INSERT post keyed on the upserted user's id.
		err := rt.WithAmbientTransaction(func() error {
			_, e := nestedUpsert(in.Str("email"), in.Str("name"), in.Str("title"))
			return e
		})
		return err
	case "nestedUpdate":
		// UPDATE the seeded user RETURNING id → UPDATE that user's posts.
		err := rt.WithAmbientTransaction(func() error {
			_, e := nestedUpdate(in.Int("id"), in.Str("name"), in.Str("title"))
			return e
		})
		return err
	case "delete":
		// Create-then-delete: INSERT a fresh user RETURNING id → DELETE the exact created row by id.
		err := rt.WithAmbientTransaction(func() error {
			_, e := delete(in.Str("email"), in.Str("name"))
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
	mode := ""
	if len(os.Args) > 1 {
		mode = os.Args[1]
	}
	doBench := mode == "bench"
	captureSQL := mode == "sql"

	db, err := openSeeded()
	if err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: seed: %v\n", err)
		os.Exit(1)
	}
	defer db.Close()
	rt.BindLeafTransport(rt.ContextForDB(db), benchDialect)
	defer rt.UnbindLeafTransport()

	// The N+1-avoidance / atomic-tx safety proof: a seam middleware counts EVERY statement that funnels
	// through Execute/Run (reads + writes + tx-control BEGIN/COMMIT) — the SAME lens the python/php cells
	// use. The bound leaf ctx resolves the process-global registry, so a global registration is seen.
	var stmtCount int64
	var rowCount int64
	var seenSQL []string
	counter := rt.NewMiddleware(rt.MiddlewareConfig{
		Execute: func(_ any, next rt.ExecNext, sqlText string, args []any) (any, error) {
			atomic.AddInt64(&stmtCount, 1)
			// The tx-control statements are the runtime's, not the generated runner's: a baseline
			// brackets its own transaction, so only the body statements are captured.
			if !txControl.MatchString(sqlText) {
				seenSQL = append(seenSQL, canonicalPlaceholders(sqlText))
			}
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
	// The rows each op moves, measured in the proof pass below (iteration 0, off the timed loop) — the
	// report's per-row denominator (#170).
	rowsByOp := map[string]int64{}
	// The statements each op issued, in order — written to the artifact by the `sql` mode (#172).
	opSQL := map[string][]string{}
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
		seenSQL = nil
		if err := op(doc, name, 0); err != nil {
			fmt.Printf("%-20s  ERR: %v\n", name, err)
			fail++
			continue
		}
		q := int(atomic.LoadInt64(&stmtCount))
		// Rows as counted at the seam — every row of every statement, not the terminal slice length (a
		// relation's terminal holds 100 parents while the op moved 11,100 rows).
		rows := int(atomic.LoadInt64(&rowCount))
		rowsByOp[name] = int64(rows)
		opSQL[name] = append([]string(nil), seenSQL...)
		mark := "ok"
		if exp, ok := expectedStatements[name]; ok && exp != q {
			mark = fmt.Sprintf("STATEMENT-COUNT MISMATCH (want %d)", exp)
			fail++
		}
		kind := ""
		if txOps[name] {
			kind = " (BEGIN + 2 body + COMMIT)"
		}
		// The machine-readable half, in the ONE format every cell prints, so `run-cells.sh` can hold the
		// ten cells to the same statements and rows per op instead of ten human tables being eyeballed.
		fmt.Printf("proof,native,%s,%s,%d,%d\n", benchDialect, name, q, rows)
		fmt.Printf("%-20s  %-10d  %-5d %s%s\n", name, q, rows, mark, kind)
	}

	if captureSQL {
		if err := setup.WriteOps(benchDialect, opSQL); err != nil {
			fmt.Fprintf(os.Stderr, "FATAL: write ops: %v\n", err)
			os.Exit(1)
		}
		path, _ := setup.Path(benchDialect)
		fmt.Fprintf(os.Stderr, "  ✓ %s — ops captured for %d op(s)\n", path, len(opSQL))
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
		// Profiling + op selection, for asking WHERE the time goes rather than guessing (#258 asks for a
		// profile and says not to optimise on a hunch). Both are env-only so the positional argv the
		// harness passes (`bench <reps> <warmup>`) is untouched, and both are inert when unset — the CSV
		// this prints is byte-identical without them.
		//   LM_CPUPROFILE=<path>   write a pprof CPU profile over the whole timed loop
		//   LM_ONLY_OP=<name>[,…]  time only these ops, so a profile is not diluted by the other 18
		if path := os.Getenv("LM_CPUPROFILE"); path != "" {
			f, err := os.Create(path)
			if err != nil {
				fmt.Fprintf(os.Stderr, "FATAL: cpuprofile: %v\n", err)
				os.Exit(1)
			}
			defer f.Close()
			if err := pprof.StartCPUProfile(f); err != nil {
				fmt.Fprintf(os.Stderr, "FATAL: cpuprofile: %v\n", err)
				os.Exit(1)
			}
			defer pprof.StopCPUProfile()
			fmt.Fprintf(os.Stderr, "  cpu profile → %s\n", path)
		}
		if only := os.Getenv("LM_ONLY_OP"); only != "" {
			want := map[string]bool{}
			for _, n := range strings.Split(only, ",") {
				want[strings.TrimSpace(n)] = true
			}
			kept := ops[:0:0]
			for _, n := range ops {
				if want[n] {
					kept = append(kept, n)
				}
			}
			if len(kept) == 0 {
				fmt.Fprintf(os.Stderr, "FATAL: LM_ONLY_OP=%q matched none of the %d covered ops\n", only, len(ops))
				os.Exit(1)
			}
			ops = kept
			fmt.Fprintf(os.Stderr, "  timing %d of the covered op(s): %s\n", len(ops), strings.Join(ops, ", "))
		}
		fmt.Println("\ncell,dialect,op,iter,us,rows")
		for _, name := range ops {
			if err := reseed(db, doc); err != nil {
				fmt.Fprintf(os.Stderr, "FATAL: %v\n", err)
				os.Exit(1)
			}
			for it := 0; it < warmup; it++ {
				if err := op(doc, name, it+1); err != nil {
					fmt.Fprintf(os.Stderr, "warmup %s: %v\n", name, err)
					os.Exit(1)
				}
			}
			for it := 0; it < reps; it++ {
				g := it + warmup + 1
				t := time.Now()
				if err := op(doc, name, g); err != nil {
					fmt.Fprintf(os.Stderr, "bench %s: %v\n", name, err)
					os.Exit(1)
				}
				us := time.Since(t).Microseconds()
				fmt.Printf("native,%s,%s,%d,%d,%d\n", benchDialect, name, it, us, rowsByOp[name])
			}
		}
	}

	if fail > 0 {
		fmt.Fprintf(os.Stderr, "\nFAILED: %d op(s) errored or mismatched.\n", fail)
		os.Exit(1)
	}
	fmt.Println("\nOK: all 19 covered ops ran green; relation counts are N+1-free; tx counts are atomic (BEGIN+2 body+COMMIT).")
}
