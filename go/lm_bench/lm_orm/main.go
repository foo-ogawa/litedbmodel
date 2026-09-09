// Command lm_orm — the raw-driver SDK-baseline ORM-bench cell (Go), twin of go/lm_bench/lm_orm_native.
//
// The apples-to-apples SDK comparison for the go native cell: it runs the SAME 19 ORM ops over the SAME
// canonical fixture, with the SAME statements, values and RETURNING recoveries — all four from the ONE
// artifact every cell reads (.setup/<dialect>.json: `schema`/`delete`/`insert`, `ops`, `inputs`,
// `recover`/`batchColumns`) — against the SAME database the native cell of that dialect drives, but
// issued straight at database/sql. litedbmodel_runtime and the bc-generated
// RunNativeRawStruct_* runners are NOT in the path (#157 invariant 6): in particular MySQL is opened
// with the PLAIN go-sql-driver, never the runtime's RETURNING-emulating "mysql-scp" wrapper, which
// would hand the raw baseline a feature a raw driver does not have.
//
// Fairness (a strawman SDK invalidates the comparison):
//   - SAME storage per dialect: in-memory sqlite, or the same docker PG:5433 / MySQL:3307.
//   - Prepared-statement REUSE: every op's SQL is prepared once and cached (map[string]*sql.Stmt),
//     matching native's runtime prepared-statement cache — not re-parsed per call.
//   - N+1-FREE relations: parent read → pluck keys → ONE batched child read (WHERE fk IN (…)) → group
//     in memory, the SAME query counts the native cell proves (nestedFindAll=2, nestedRelations=3,
//     compositeRelations=3, batch write=1, RETURNING-chained tx = BEGIN + 2 body + COMMIT = 4).
//   - SAME seed as the native twin: behaviors.STATEMENTS + behaviors.SEED, seeded ONCE (the native cell
//     seeds once too), and the SAME per-op inputs (findUnique=user500, update id=1, …).
//
// Modes:
//
//	lm_orm <dialect>        — run all 19 ops once; print per-op statement-count + row-count; assert the
//	                          N+1-free relation counts + the atomic tx statement counts (safety proof).
//	lm_orm <dialect> bench [reps] [warmup]
//	                        — additionally time each op over reps iterations (after warmup) and print a
//	                          flat CSV (cell,dialect,op,iter,us,rows) with cell label `sdk`.
package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"github.com/foo-ogawa/litedbmodel/go/v3/lm_bench/setup"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	_ "github.com/go-sql-driver/mysql" // plain MySQL driver (registered as "mysql") — NOT the runtime's mysql-scp
	_ "github.com/jackc/pgx/v5/stdlib" // plain Postgres driver (registered as "pgx")
	_ "modernc.org/sqlite"             // PURE-GO sqlite driver (registered as "sqlite")
)

// ── the ONE exec seam. All DB access rides these methods, so the prepared-statement cache and the
//
//	per-op statement counter each live in exactly one place. ────────────────────────────────────────
type cell struct {
	db      *sql.DB
	dialect string               // the target; every dialect divergence below is derived from it
	stmts   map[string]*sql.Stmt // per-SQL prepared-statement cache (reused across iterations)
	tx      *sql.Tx              // the OPEN transaction, if any — every statement in one runs on it
	count   int64                // statement counter (safety proof); bumped once per prepared statement
	rows    int64                // rows this cell scanned (#170) — the report's per-row denominator, and
	// the proof this hand-written baseline moved the SAME rows the runtime cell did
}

// render rewrites the `?` every op below writes into this driver's placeholder form: pgx binds `$N`
// positionally, go-sql-driver and sqlite take `?` as written. One place, so no op carries a dialect if.
func (c *cell) render(sqlText string) string {
	if c.dialect != "postgres" {
		return sqlText
	}
	var out strings.Builder
	n := 0
	for _, ch := range sqlText {
		if ch == '?' {
			n++
			fmt.Fprintf(&out, "$%d", n)
		} else {
			out.WriteRune(ch)
		}
	}
	return out.String()
}

func (c *cell) prep(sqlText string) *sql.Stmt {
	sqlText = c.render(sqlText)
	if s, ok := c.stmts[sqlText]; ok {
		return s
	}
	s, err := c.db.Prepare(sqlText)
	if err != nil {
		panic(fmt.Sprintf("prepare %q: %v", sqlText, err))
	}
	c.stmts[sqlText] = s
	return s
}

// stmt returns the cached prepared statement BOUND TO THE CURRENT SCOPE: the open transaction if there
// is one, the pool otherwise. Every statement inside BEGIN..COMMIT must run on the transaction's own
// connection — that is what makes it atomic.
func (c *cell) stmt(sqlText string) *sql.Stmt {
	if c.tx != nil {
		// Inside a transaction, prepare on the TRANSACTION's own connection. `tx.Stmt` over a DB-cached
		// statement re-prepares on that connection anyway — a tx statement is closed with the tx — so this
		// costs the same and never asks the pool for a second connection. That request is what deadlocked
		// SQLite, whose pool is capped at 1 because the in-memory database has to be shared:
		//
		//	fatal error: all goroutines are asleep - deadlock!
		//	database/sql.(*DB).conn ... database/sql.(*DB).prepare ... (*DB).Prepare
		st, err := c.tx.Prepare(c.render(sqlText))
		if err != nil {
			panic(fmt.Sprintf("prepare in tx %q: %v", sqlText, err))
		}
		return st
	}
	return c.prep(sqlText)
}

// begin / commit use database/sql's OWN transaction API rather than sending the words through Exec.
// This is not style. `db.Exec("BEGIN")` leaves database/sql unaware that the connection is now in a
// transaction: it hands the connection back to the pool, cannot reuse it safely, and reconnects —
// measured against this bench's Postgres, 20 iterations each:
//
//	db.Exec("BEGIN") + db.Exec("COMMIT"), nothing between   7625 us
//	Exec(BEGIN) + INSERT..RETURNING + Exec(COMMIT)          8867 us
//	db.Begin()  + INSERT..RETURNING + tx.Commit()            929 us
//	one INSERT..RETURNING, autocommit                         258 us
//
// So ~8ms per tx op was connection churn inside the driver layer, not the database and not fsync. It
// made this baseline read ~12x the library it is the baseline FOR, on the four tx ops only. Both forms
// put BEGIN and COMMIT on the wire, so the statement count is unchanged at 4.
func (c *cell) begin() {
	c.count++
	tx, err := c.db.Begin()
	if err != nil {
		panic(fmt.Sprintf("begin: %v", err))
	}
	c.tx = tx
}

func (c *cell) commit() {
	c.count++
	if err := c.tx.Commit(); err != nil {
		panic(fmt.Sprintf("commit: %v", err))
	}
	c.tx = nil
}

// query runs a prepared SELECT and materialises EVERY column of every row (fair vs the native cell,
// which decodes full typed structs), returning each row as a []any. Only key columns are read
// downstream for batching, but all columns are scanned to pay the real decode cost.
func (c *cell) query(sqlText string, args ...any) [][]any {
	c.count++
	return c.recoverRows(sqlText, args...)
}

// recoverRows fetches and tallies rows WITHOUT bumping the statement count. It is the body of `query`,
// and it is also the MySQL RETURNING recovery, which belongs to the logical statement just issued.
func (c *cell) recoverRows(sqlText string, args ...any) [][]any {
	rows, err := c.stmt(sqlText).Query(args...)
	if err != nil {
		panic(fmt.Sprintf("query %q: %v", sqlText, err))
	}
	defer rows.Close()
	cols, _ := rows.Columns()
	var out [][]any
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			panic(fmt.Sprintf("scan %q: %v", sqlText, err))
		}
		out = append(out, vals)
	}
	c.rows += int64(len(out))
	return out
}

// writeResult is what a driver reports about a write. `hasID` is false where the driver has no
// last-insert-id to give (pgx) — PostgreSQL never needs one, since it executes RETURNING itself.
type writeResult struct {
	insertID int64
	affected int64
	hasID    bool
}

// exec runs a prepared, parameterised write on the current scope (the open transaction, or the pool).
func (c *cell) exec(sqlText string, args ...any) writeResult {
	c.count++
	res, err := c.stmt(sqlText).Exec(args...)
	if err != nil {
		panic(fmt.Sprintf("exec %q: %v", sqlText, err))
	}
	out := writeResult{}
	if n, e := res.RowsAffected(); e == nil {
		out.affected = n
	}
	if id, e := res.LastInsertId(); e == nil {
		out.insertID, out.hasID = id, true
	}
	return out
}

// bindRecovery resolves the recovering SELECT's params from the write's own params and what the driver
// reported — the `bindReselect` of src/scp/makesql/mysql-returning.ts, which is where these kinds are
// defined. A kind the driver cannot answer is a HARD failure: recovering the wrong rows quietly is the
// defect this path exists to remove.
func bindRecovery(binds []setup.Bind, params []any, wrote writeResult) []any {
	out := make([]any, len(binds))
	for i, b := range binds {
		if b.Kind == "param" {
			out[i] = params[b.Index]
			continue
		}
		if !wrote.hasID {
			panic(fmt.Sprintf("recovery binds %q, but this driver reported no insert id for the write", b.Kind))
		}
		switch b.Kind {
		case "lastId":
			out[i] = wrote.insertID
		case "highId":
			n := wrote.affected
			if n < 1 {
				n = 1
			}
			out[i] = wrote.insertID + n
		default:
			panic(fmt.Sprintf("unknown recovery bind kind %q", b.Kind))
		}
	}
	return out
}

// writeReturningID runs a write that hands back the id of the row it wrote — the ` RETURNING id` the
// authored native module declares for every id-chaining write (benchmark/crosslang/native-model.ts).
// The baseline issues the SAME statement and reads the SAME row back, so the two surfaces do equal work.
//
// `rec` is the artifact's recovery for this statement: nil wherever the database executes the RETURNING
// itself, and on MySQL — which cannot parse it — the write with the clause stripped plus the keyed
// SELECT that recovers the written rows. Both come from the library's own `buildMysqlReselect`
// (benchmark/crosslang/derive-ops.ts), so the baseline issues exactly what the runtime issues instead of
// a hand-copied guess at it. The recovery is part of the SAME logical statement: the runtime's own seam
// counts a MySQL RETURNING write as ONE (it issues the recovery below the seam) while counting the row
// it recovers, so this tallies the rows without bumping the statement count a second time.
func (c *cell) writeReturningID(sqlText string, rec *setup.Recovery, args ...any) int64 {
	if rec == nil {
		rows := c.query(sqlText, args...)
		return asInt(rows[0][0])
	}
	wrote := c.exec(rec.WriteSQL, args...)
	rows := c.recoverRows(rec.SelectSQL, bindRecovery(rec.Binds, args, wrote)...)
	return asInt(rows[0][0])
}

// asInt coerces a scanned cell to int64. Each driver reports integers its own way: sqlite and
// go-sql-driver as int64, pgx as int32 for int4 / int16 for int2, and MySQL sometimes as raw bytes.
func asInt(v any) int64 {
	switch n := v.(type) {
	case int64:
		return n
	case int32:
		return int64(n)
	case int16:
		return int64(n)
	case int:
		return int64(n)
	case []byte:
		i, _ := strconv.ParseInt(string(n), 10, 64)
		return i
	case string:
		i, _ := strconv.ParseInt(n, 10, 64)
		return i
	default:
		return 0
	}
}

// openSeeded opens the target DB — the SAME database the native cell of that dialect drives (#157
// invariant 1) — and applies this dialect's schema from the ONE seed SSoT (.setup/<dialect>.json, from
// orm-domain.ts; invariant 2). The connection is the PLAIN driver: no litedbmodel_runtime, no generated
// module (invariant 6). An unknown dialect is a LOUD failure — there is no sqlite fallback.
func openSeeded(dialect string) *cell {
	doc, err := setup.Load(dialect)
	if err != nil {
		panic(err)
	}
	var db *sql.DB
	switch dialect {
	case "sqlite":
		db, err = sql.Open("sqlite", ":memory:")
		if err == nil {
			db.SetMaxOpenConns(1) // one in-memory connection so schema + seed + ops share the same DB
			db.SetMaxIdleConns(1)
		}
	case "postgres":
		db, err = sql.Open("pgx", setup.PostgresDSN())
	case "mysql":
		db, err = sql.Open("mysql", setup.MysqlDSN())
	default:
		panic(fmt.Sprintf("unknown dialect %q (sqlite|postgres|mysql)", dialect))
	}
	if err != nil {
		panic(fmt.Sprintf("open %s: %v", dialect, err))
	}
	if err := db.Ping(); err != nil {
		panic(fmt.Sprintf("connect %s: %v", dialect, err))
	}
	c := &cell{db: db, dialect: dialect, stmts: map[string]*sql.Stmt{}}
	for _, s := range doc.Schema {
		if _, err := db.Exec(s); err != nil {
			panic(fmt.Sprintf("schema %q: %v", s, err))
		}
	}
	c.seed(doc)
	return c
}

// seed re-applies this dialect's canonical fixture. Run before EACH op (as the python/php/rust cells
// do), OFF the counted seam so it never lands in a statement count or a timing.
func (c *cell) seed(doc setup.Doc) {
	for _, group := range [][]string{doc.Delete, doc.Insert} {
		for _, s := range group {
			if _, err := c.db.Exec(s); err != nil {
				panic(fmt.Sprintf("seed %q: %v", s, err))
			}
		}
	}
}

// ── nested materialization (fair vs the native cell) ─────────────────────────────────────────────────
// The native ORM assembles a nested TYPED object graph: each parent record with its child list nested
// under the relation key (the runtime group_children builds it; the generated de-box holds it). The SDK
// mirrors that — decode every selected column into a plain typed struct and ATTACH the grouped children
// into their parent BY MOVE (assign the grouped slice into parent.<children>, no per-parent element
// copy). The fully-assembled []parent is sunk into benchSink so it is not optimized away.
//
// The payload fields (email/name/title/body) are decoded-then-held (the same decode the native pays) but
// never read downstream — only the key columns drive the grouping.
type sdkUser struct {
	id    int64
	email any
	name  any
	posts []sdkPost
}
type sdkPost struct {
	id       int64
	title    any
	authorID int64
	comments []sdkComment
}

// sdkPostFull is `filterPaginateSort`'s row — the FULL projection the native module declares as
// `PostFullRow`. A read is only usable as data once its columns are in a typed field, so the baseline
// decodes into this exactly as the native cell de-boxes into its own row type; stopping at the driver's
// generic `[]any` would compare a decode against no decode.
type sdkPostFull struct {
	id        int64
	title     any
	content   any
	published int64
	authorID  int64
	createdAt any
}

func decodePostsFull(rows [][]any) []sdkPostFull {
	out := make([]sdkPostFull, len(rows))
	for i, r := range rows {
		out[i] = sdkPostFull{
			id: asInt(r[0]), title: r[1], content: r[2],
			published: asInt(r[3]), authorID: asInt(r[4]), createdAt: r[5],
		}
	}
	return out
}

type sdkComment struct {
	id     int64
	body   any
	postID int64
}
type sdkTenantUser struct {
	tenantID int64
	userID   int64
	name     any
	posts    []sdkTenantPost
}
type sdkTenantPost struct {
	tenantID int64
	postID   int64
	userID   int64
	title    any
	comments []sdkTenantComment
}
type sdkTenantComment struct {
	tenantID  int64
	commentID int64
	postID    int64
	body      any
}

// key2 is the composite (tenant_id,*) grouping key — group on the FULL tuple (no scalar-collapse).
type key2 struct{ a, b int64 }

// benchSink holds the last materialized graph so the compiler cannot elide the assembly work (the Go
// analogue of the rust cell's black_box(&roots) / a package-level escape).
var benchSink any

func decodeUsers(rows [][]any) []sdkUser {
	out := make([]sdkUser, len(rows))
	for i, r := range rows {
		out[i] = sdkUser{id: asInt(r[0]), email: r[1], name: r[2]}
	}
	return out
}
func decodePosts(rows [][]any) []sdkPost {
	out := make([]sdkPost, len(rows))
	for i, r := range rows {
		out[i] = sdkPost{id: asInt(r[0]), title: r[1], authorID: asInt(r[2])}
	}
	return out
}
func decodeComments(rows [][]any) []sdkComment {
	out := make([]sdkComment, len(rows))
	for i, r := range rows {
		out[i] = sdkComment{id: asInt(r[0]), body: r[1], postID: asInt(r[2])}
	}
	return out
}

// materializeUsersPosts: ONE batched child posts read, decoded into typed structs and MOVED into their
// parent user by author_id (2 queries; the parent read already happened in the op arm).
func (c *cell) materializeUsersPosts(userRows [][]any, childSQL string) []sdkUser {
	users := decodeUsers(userRows)
	if len(users) == 0 {
		return users
	}
	ids := make([]int64, len(users))
	for i, u := range users {
		ids[i] = u.id
	}
	keys := make([][]int64, len(ids))
	for i, id := range ids {
		keys[i] = []int64{id}
	}
	posts := decodePosts(c.query(childSQL, keyParam(childSQL, keys)))
	byAuthor := make(map[int64][]sdkPost, len(posts))
	for _, p := range posts {
		byAuthor[p.authorID] = append(byAuthor[p.authorID], p)
	}
	for i := range users {
		users[i].posts = byAuthor[users[i].id] // MOVE the grouped slice into the parent
	}
	return users
}

// materializeUsersPostsComments: 3-level chain — batched posts then batched comments, assembled into the
// full nested typed graph (comments MOVED into posts by post_id, posts MOVED into users by author_id).
func (c *cell) materializeUsersPostsComments(userRows [][]any, postSQL, commentSQL string) []sdkUser {
	users := decodeUsers(userRows)
	if len(users) == 0 {
		return users
	}
	ukeys := make([][]int64, len(users))
	for i, u := range users {
		ukeys[i] = []int64{u.id}
	}
	posts := decodePosts(c.query(postSQL, keyParam(postSQL, ukeys)))
	if len(posts) > 0 {
		pkeys := make([][]int64, len(posts))
		for i, p := range posts {
			pkeys[i] = []int64{p.id}
		}
		comments := decodeComments(c.query(commentSQL, keyParam(commentSQL, pkeys)))
		byPost := make(map[int64][]sdkComment, len(comments))
		for _, cm := range comments {
			byPost[cm.postID] = append(byPost[cm.postID], cm)
		}
		for i := range posts {
			posts[i].comments = byPost[posts[i].id] // MOVE the grouped slice into the parent
		}
	}
	byAuthor := make(map[int64][]sdkPost, len(posts))
	for _, p := range posts {
		byAuthor[p.authorID] = append(byAuthor[p.authorID], p)
	}
	for i := range users {
		users[i].posts = byAuthor[users[i].id]
	}
	return users
}

// materializeComposite: tenant_users(tenant=1) → batched tenant_posts by (tenant_id,user_id) → batched
// tenant_comments by (tenant_id,post_id). 3 queries; assembled into the nested typed graph keyed on the
// FULL composite (tenant_id,*) tuple.
func (c *cell) materializeComposite(sqlList []string) []sdkTenantUser {
	trows := c.query(sqlList[0])
	tusers := make([]sdkTenantUser, len(trows))
	for i, r := range trows {
		tusers[i] = sdkTenantUser{tenantID: asInt(r[0]), userID: asInt(r[1]), name: r[2]}
	}
	if len(tusers) == 0 {
		return tusers
	}
	ukeys := make([][]int64, len(tusers))
	for i, u := range tusers {
		ukeys[i] = []int64{u.tenantID, u.userID}
	}
	prows := c.query(sqlList[1], keyParam(sqlList[1], ukeys))
	tposts := make([]sdkTenantPost, len(prows))
	for i, r := range prows {
		tposts[i] = sdkTenantPost{tenantID: asInt(r[0]), postID: asInt(r[1]), userID: asInt(r[2]), title: r[3]}
	}
	if len(tposts) > 0 {
		pkeys := make([][]int64, len(tposts))
		for i, p := range tposts {
			pkeys[i] = []int64{p.tenantID, p.postID}
		}
		crows := c.query(sqlList[2], keyParam(sqlList[2], pkeys))
		byPost := make(map[key2][]sdkTenantComment, len(crows))
		for _, r := range crows {
			cm := sdkTenantComment{tenantID: asInt(r[0]), commentID: asInt(r[1]), postID: asInt(r[2]), body: r[3]}
			k := key2{cm.tenantID, cm.postID}
			byPost[k] = append(byPost[k], cm)
		}
		for i := range tposts {
			tposts[i].comments = byPost[key2{tposts[i].tenantID, tposts[i].postID}]
		}
	}
	byUser := make(map[key2][]sdkTenantPost, len(tposts))
	for _, p := range tposts {
		k := key2{p.tenantID, p.userID}
		byUser[k] = append(byUser[k], p)
	}
	for i := range tusers {
		tusers[i].posts = byUser[key2{tusers[i].tenantID, tusers[i].userID}]
	}
	return tusers
}

// keyParam encodes one relation level's key set as the ONE param the captured SQL expects. The generated
// module binds a batched child read's key set as a single JSON array (json_each(?) / JSON_TABLE(?) /
// UNNEST(?::t[])), never as N placeholders — so the baseline binds it the same way, or it is running
// different SQL. A composite key is an array of tuples, a single key an array of scalars.
func keyParam(sqlText string, tuples [][]int64) string {
	// The statement says which encoding it wants: an ARRAY cast (`$1::int[]`, PostgreSQL's single-key
	// predicate) takes a PostgreSQL array literal; a `::json` cast and MySQL/SQLite's json_each /
	// JSON_TABLE take JSON. Reading it off the SQL keeps the encoding tied to the statement.
	if pgArrayCast.MatchString(sqlText) {
		flat := make([]string, len(tuples))
		for i, t := range tuples {
			flat[i] = strconv.FormatInt(t[0], 10)
		}
		return "{" + strings.Join(flat, ",") + "}"
	}
	out, err := json.Marshal(flattenSingles(tuples))
	if err != nil {
		panic(fmt.Sprintf("encode key set: %v", err))
	}
	return string(out)
}

// pgArrayCast matches a statement that casts its param to a PostgreSQL array (`::int[]` / `::text[]`).
var pgArrayCast = regexp.MustCompile(`::\w+\[\]`)

// pgArrayLiteral renders values as a PostgreSQL array literal (`{a,b}`), bound as TEXT and cast by the
// statement's own `::int[]` / `::text[]` — so no driver-specific array support is needed.
func pgArrayLiteral(vals []string, quote bool) string {
	out := make([]string, len(vals))
	for i, v := range vals {
		if quote {
			out[i] = `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(v) + `"`
		} else {
			out[i] = v
		}
	}
	return "{" + strings.Join(out, ",") + "}"
}

// flattenSingles renders a 1-column key set as scalars and a multi-column one as tuples.
func flattenSingles(tuples [][]int64) any {
	if len(tuples) > 0 && len(tuples[0]) == 1 {
		flat := make([]int64, len(tuples))
		for i, t := range tuples {
			flat[i] = t[0]
		}
		return flat
	}
	return tuples
}

// batchParams renders a batch write's record set as the param(s) the captured statement expects: ONE JSON
// array on MySQL/SQLite, one array PER COLUMN on PostgreSQL (its UNNEST form takes column arrays). The
// payload repeats once per `?` — updateMany's SET subquery and its WHERE each read it.
//
// `columns` is the statement's OWN column list (.setup/<dialect>.json `batchColumns`, read off the SQL
// by derive-ops.ts). PostgreSQL's `UNNEST(?::int[], ?::text[]) AS v(id, name)` binds the Nth array to
// the Nth alias, so the order is the statement's to choose; sorting the record's keys here agreed with
// it only by coincidence.
func (c *cell) batchParams(sqlText string, columns []string, records []setup.Values) []any {
	var one []any
	if c.dialect == "postgres" {
		for _, col := range columns {
			vals := make([]string, len(records))
			numeric := true
			for i, r := range records {
				// JSON decodes every number to float64; a declared `id` column is an integer.
				if n, ok := r[col].(float64); ok {
					vals[i] = strconv.FormatInt(int64(n), 10)
				} else {
					vals[i] = fmt.Sprint(r[col])
					numeric = false
				}
			}
			one = append(one, pgArrayLiteral(vals, !numeric))
		}
	} else {
		enc, err := json.Marshal(records)
		if err != nil {
			panic(fmt.Sprintf("encode batch records: %v", err))
		}
		one = []any{string(enc)}
	}
	n := strings.Count(sqlText, "?") / len(one)
	if n < 1 {
		n = 1
	}
	out := make([]any, 0, n*len(one))
	for i := 0; i < n; i++ {
		out = append(out, one...)
	}
	return out
}

// ── the 19 ops (native-cell order). Fixed inputs mirror the go native cell; mutating ops vary their
//
//	UNIQUE column by it. Reads: LIMIT/ORDER shapes match the ops SSoT (== the native generated SQL). ──
//
// op runs ONE op for iteration it, issuing the statements the GENERATED module issues for this dialect
// (`sqlList` = doc.Ops[name], captured at the runtime seam). The baseline hand-writes no SQL: the report
// divides native by sdk, which only isolates the runtime's cost if both send the DB the same statements.
// What stays hand-written is what a raw-driver user writes: param binding, decode, grouping children into
// parents, and the transaction bracket.
func (c *cell) op(doc setup.Doc, name string, it int) {
	sqlList := doc.Ops[name]
	in := doc.Input(name, it)
	rec := func(i int) *setup.Recovery { return doc.Recovery(name, i) }
	switch name {
	case "findAll":
		benchSink = decodeUsers(c.query(sqlList[0]))
	case "filterPaginateSort":
		benchSink = decodePostsFull(c.query(sqlList[0], in.Int("published")))
	case "findFirst":
		benchSink = decodeUsers(c.query(sqlList[0], in.Str("name")))
	case "findUnique":
		benchSink = decodeUsers(c.query(sqlList[0], in.Str("email")))
	case "nestedFindAll":
		benchSink = c.materializeUsersPosts(c.query(sqlList[0]), sqlList[1])
	case "nestedFindFirst":
		benchSink = c.materializeUsersPosts(c.query(sqlList[0], in.Str("name")), sqlList[1])
	case "nestedFindUnique":
		benchSink = c.materializeUsersPosts(c.query(sqlList[0], in.Str("email")), sqlList[1])
	case "nestedRelations":
		benchSink = c.materializeUsersPostsComments(c.query(sqlList[0]), sqlList[1], sqlList[2])
	case "compositeRelations":
		benchSink = c.materializeComposite(sqlList)
	case "create":
		c.exec(sqlList[0], in.Str("email"), in.Str("name"))
	case "update":
		c.exec(sqlList[0], in.Str("name"), in.Int("id"))
	case "upsert":
		// The captured statement declares ` RETURNING id`, so the baseline reads the id back too.
		benchSink = c.writeReturningID(sqlList[0], rec(0), in.Str("email"), in.Str("name"))
	case "createMany", "upsertMany", "updateMany":
		// The SAME 10 records the native module writes, bound the way the statement asks for them.
		c.exec(sqlList[0], c.batchParams(sqlList[0], doc.Columns(name), in.Records("rows"))...)
	case "nestedCreate":
		c.begin()
		uid := c.writeReturningID(sqlList[0], rec(0), in.Str("email"), in.Str("name"))
		c.exec(sqlList[1], uid, in.Str("title"))
		c.commit()
	case "nestedUpsert":
		c.begin()
		uid := c.writeReturningID(sqlList[0], rec(0), in.Str("email"), in.Str("name"))
		c.exec(sqlList[1], uid, in.Str("title"))
		c.commit()
	case "nestedUpdate":
		c.begin()
		// The generated runner chains the dependent UPDATE off the id the first UPDATE returned; taking
		// the id from the input instead would skip a statement's worth of work.
		uid := c.writeReturningID(sqlList[0], rec(0), in.Str("name"), in.Int("id"))
		c.exec(sqlList[1], in.Str("title"), uid)
		c.commit()
	case "delete":
		c.begin()
		uid := c.writeReturningID(sqlList[0], rec(0), in.Str("email"), in.Str("name"))
		c.exec(sqlList[1], uid)
		c.commit()
	default:
		panic("unknown op " + name)
	}
}

var ops = []string{
	"findAll", "filterPaginateSort", "findFirst", "findUnique",
	"nestedFindAll", "nestedFindFirst", "nestedFindUnique", "nestedRelations", "compositeRelations",
	"create", "update", "upsert",
	"createMany", "upsertMany", "updateMany",
	"nestedCreate", "nestedUpsert", "nestedUpdate", "delete",
}

// expectedStatements — the per-op hand-issued statement count (reads + writes + tx-control BEGIN/COMMIT;
// pluck/group are in-memory and do NOT issue statements). Matches the native cell's expectations.
var expectedStatements = map[string]int{
	"findAll": 1, "filterPaginateSort": 1, "findFirst": 1, "findUnique": 1,
	"nestedFindAll": 2, "nestedFindFirst": 2, "nestedFindUnique": 2, "nestedRelations": 3, "compositeRelations": 3,
	"create": 1, "update": 1, "upsert": 1,
	"createMany": 1, "upsertMany": 1, "updateMany": 1,
	"nestedCreate": 4, "nestedUpsert": 4, "nestedUpdate": 4, "delete": 4,
}

var txOps = map[string]bool{"nestedCreate": true, "nestedUpsert": true, "nestedUpdate": true, "delete": true}

func main() {
	dialect := "sqlite"
	if len(os.Args) > 1 && os.Args[1] != "bench" {
		dialect = os.Args[1]
	}
	rest := os.Args[1:]
	if len(rest) > 0 && rest[0] == dialect {
		rest = rest[1:]
	}
	doBench := len(rest) > 0 && rest[0] == "bench"

	c := openSeeded(dialect)
	defer c.db.Close()
	doc, err := setup.Load(dialect)
	if err != nil {
		panic(err)
	}

	fmt.Println("op                    statements  rows")
	// The rows each op moves, measured in the proof pass below (iteration 0, off the timed loop) — the
	// report's per-row denominator (#170).
	rowsByOp := map[string]int64{}
	fail := 0
	for _, name := range ops {
		c.seed(doc) // clean fixture per op (matches the python/php/rust cells); off-seam, never counted
		c.count = 0
		c.rows = 0
		c.op(doc, name, 0)
		q := int(c.count)
		mark := "ok"
		if exp, okk := expectedStatements[name]; okk && exp != q {
			mark = fmt.Sprintf("STATEMENT-COUNT MISMATCH (want %d)", exp)
			fail++
		}
		kind := ""
		if txOps[name] {
			kind = " (BEGIN + body + COMMIT)"
		}
		rowsByOp[name] = c.rows
		// The machine-readable half, in the ONE format every cell prints, so `run-cells.sh` can hold the
		// ten cells to the same statements and rows per op instead of ten human tables being eyeballed.
		fmt.Printf("proof,sdk,%s,%s,%d,%d\n", c.dialect, name, q, c.rows)
		fmt.Printf("%-20s  %-10d  %-5d %s%s\n", name, q, c.rows, mark, kind)
	}

	if doBench {
		reps := 300
		warmup := 30
		if len(rest) > 1 {
			if n, e := strconv.Atoi(rest[1]); e == nil {
				reps = n
			}
		}
		if len(rest) > 2 {
			if n, e := strconv.Atoi(rest[2]); e == nil {
				warmup = n
			}
		}
		fmt.Println("\ncell,dialect,op,iter,us,rows")
		for _, name := range ops {
			c.seed(doc) // clean fixture per op, as in the safety pass above
			for it := 0; it < warmup; it++ {
				c.op(doc, name, it+1)
			}
			for it := 0; it < reps; it++ {
				g := it + warmup + 1
				t := time.Now()
				c.op(doc, name, g)
				fmt.Printf("sdk,%s,%s,%d,%d,%d\n", c.dialect, name, it, time.Since(t).Microseconds(), rowsByOp[name])
			}
		}
	}

	if fail > 0 {
		fmt.Fprintf(os.Stderr, "\nFAILED: %d op(s) mismatched.\n", fail)
		os.Exit(1)
	}
	fmt.Fprintln(os.Stderr, "\nOK: 19 ops ran; relation counts N+1-free; batch writes = 1 statement; tx = BEGIN + body + COMMIT.")
}
