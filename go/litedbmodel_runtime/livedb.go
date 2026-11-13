// litedbmodel v2 SCP — live PostgreSQL / MySQL driver wiring (Go, WS7g #36).
//
// The Go runtime already executes through the standard database/sql surface (SQLDB / TxDB), so a
// real Postgres (pgx stdlib) and MySQL (go-sql-driver) connection plug into the SAME seam the
// SQLite conformance uses — the runtime is UNCHANGED. This file only supplies the connection
// openers plus the ONE dialect divergence a raw MySQL driver can't absorb:
//
//   - Postgres: pgx's database/sql driver natively binds `$N` (exactly what a `postgres`-tagged
//     bundle renders) and supports RETURNING — nothing to adapt.
//   - MySQL: go-sql-driver binds `?` natively (what a `mysql`-tagged bundle renders), but MySQL
//     8.0 has NO `RETURNING`. We register a THIN wrapping database/sql driver (`mysql-scp`) whose
//     connection intercepts `INSERT … RETURNING <cols>`: it strips RETURNING, runs the INSERT,
//     reads LAST_INSERT_ID(), and re-selects the requested columns by the AUTO_INCREMENT PK — the
//     dialect-behavior-by-convention the WS6 TS ScpDialect uses. Because it wraps at the driver
//     layer, the emulation is transparent to BOTH the read seam (*sql.DB) and the write-tx seam
//     (*sql.Tx) with no runtime.ts / write-runtime.ts change.

package litedbmodel_runtime

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"fmt"
	"io"
	"regexp"
	"strings"
	"sync"

	gomysql "github.com/go-sql-driver/mysql"
	_ "github.com/jackc/pgx/v5/stdlib" // registers the "pgx" database/sql driver
)

// DefaultPoolSize aligns the *sql.DB pool ceiling with the read plan's default concurrency (spec).
// The bc Go RunPlan fans out the independent sibling relations of a stage onto goroutines bounded by
// plan.Concurrency (default 16), each running through the SQLDB seam; sizing the pool to match lets
// all those concurrent siblings hold a real connection at once without queueing (#40). The write-tx
// runs on ONE connection (a single *sql.Tx), so the pool ceiling never affects write serialization.
const DefaultPoolSize = 16

// OpenPostgres opens a live Postgres via the pgx stdlib database/sql driver ($N native, RETURNING
// native). dsn e.g. "postgres://user:pass@host:port/db?sslmode=disable". The pool is sized to the
// default plan concurrency so parallel read-relation dispatch (bc#23) has connections to spend.
func OpenPostgres(dsn string) (*sql.DB, error) {
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(DefaultPoolSize)
	if err := db.Ping(); err != nil {
		return nil, err
	}
	return db, nil
}

// OpenMysql opens a live MySQL via the RETURNING-emulating "mysql-scp" driver. dsn e.g.
// "user:pass@tcp(host:port)/db?multiStatements=false". Pool sized to the default plan concurrency.
func OpenMysql(dsn string) (*sql.DB, error) {
	registerMysqlScp()
	db, err := sql.Open("mysql-scp", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(DefaultPoolSize)
	if err := db.Ping(); err != nil {
		return nil, err
	}
	return db, nil
}

// ── The RETURNING-emulating MySQL driver wrapper ───────────────────────────────

var (
	mysqlScpOnce sync.Once
	// The write's target table — the identifier after INSERT INTO / UPDATE / DELETE FROM.
	writeTableRe = regexp.MustCompile(`(?is)\b(?:INSERT\s+(?:IGNORE\s+)?INTO|UPDATE|DELETE\s+FROM)\s+([A-Za-z_][A-Za-z0-9_]*)`)
	// The INSERT column list `INSERT [IGNORE] INTO <t> (c1, c2, …)` — for client-PK / conflict-key re-select.
	insertColsRe = regexp.MustCompile(`(?is)^\s*INSERT\s+(?:IGNORE\s+)?INTO\s+[A-Za-z_][A-Za-z0-9_]*\s*\(([^)]*)\)`)
	// An updateMany's batch JOIN predicate: `ON u.k1 = <v.k1> AND u.k2 = <v.k2> SET …`.
	batchJoinOnRe = regexp.MustCompile(`(?is)\sON\s+(.*?)\s+SET\s`)
	// One `AND`-joined conjunct of that predicate; group 1 is its target-side key column.
	batchJoinConjRe = regexp.MustCompile(`^[A-Za-z0-9_]*\.?([A-Za-z0-9_]+)\s*=`)
	andSplitRe      = regexp.MustCompile(`(?i)\s+AND\s+`)
	// The strip-before-execute PK hint (mysql-returning.ts mysqlPkHint):
	// ` /*scp:pk=cols;ai=<col|>[;conflict=cols[;action=ignore]]*/`.
	pkHintRe = regexp.MustCompile(`(?is)\s*/\*scp:pk=([^;*]*);ai=([^;*]*)[^*]*\*/`)
	// The hint's `;conflict=<cols>` field (the upsert conflict target).
	conflictHintRe = regexp.MustCompile(`(?is);conflict=([^;*]*)`)
	// The hint's `;action=ignore` field (an insert-or-ignore).
	ignoreHintRe = regexp.MustCompile(`(?is);action=ignore[;*]`)
)

func registerMysqlScp() {
	mysqlScpOnce.Do(func() {
		sql.Register("mysql-scp", scpMysqlDriver{})
	})
}

// scpMysqlDriver is the "mysql-scp" driver: go-sql-driver/mysql with every connection wrapped in
// [scpMysqlConn]. It is a driver.DriverContext, so database/sql connects through [scpMysqlConnector]
// with the caller's context — a checkout deadline then bounds the MySQL handshake, which the
// driver's `timeout` (the dial only) does not.
type scpMysqlDriver struct{}

// Open is the driver.Driver entry: it connects through the same connector, without a deadline.
func (d scpMysqlDriver) Open(name string) (driver.Conn, error) {
	c, err := d.OpenConnector(name)
	if err != nil {
		return nil, err
	}
	return c.Connect(context.Background())
}

// OpenConnector parses the DSN once and returns the connector database/sql connects through.
func (d scpMysqlDriver) OpenConnector(name string) (driver.Connector, error) {
	cfg, err := gomysql.ParseDSN(name)
	if err != nil {
		return nil, err
	}
	return newScpMysqlConnector(cfg)
}

// newScpMysqlConnector is the one constructor of a "mysql-scp" connector: from a DSN
// ([scpMysqlDriver.OpenConnector]) or from a config the pool factory builds ([mysqlConfig]).
func newScpMysqlConnector(cfg *gomysql.Config) (driver.Connector, error) {
	base, err := gomysql.NewConnector(cfg)
	if err != nil {
		return nil, err
	}
	return scpMysqlConnector{base: base, foundRows: cfg.ClientFoundRows}, nil
}

// scpMysqlConnector connects with go-sql-driver's connector under the caller's context and wraps the
// connection in [scpMysqlConn].
type scpMysqlConnector struct {
	base driver.Connector
	// foundRows: the DSN's clientFoundRows (CLIENT_FOUND_ROWS) — what an affected count means.
	foundRows bool
}

func (c scpMysqlConnector) Connect(ctx context.Context) (driver.Conn, error) {
	conn, err := c.base.Connect(ctx)
	if err != nil {
		return nil, err
	}
	return &scpMysqlConn{base: conn, foundRows: c.foundRows}, nil
}

func (c scpMysqlConnector) Driver() driver.Driver { return scpMysqlDriver{} }

// scpMysqlConn wraps a go-sql-driver connection, intercepting RETURNING queries. It forwards every
// other driver capability to the base connection.
type scpMysqlConn struct {
	base driver.Conn
	// foundRows: the connection runs with CLIENT_FOUND_ROWS, under which an insert-or-ignore's
	// conflict and its insert both report 1 affected row ([writtenRowCount]).
	foundRows bool
	// inTx: a transaction is open on this connection. go-sql-driver keeps the server's status flags to
	// itself, so it is tracked where every transaction boundary of this connection passes: [BeginTx] /
	// the wrapped [scpMysqlTx], and the BEGIN / COMMIT / ROLLBACK the runtime's tx boundary issues
	// through [scpMysqlConn.ExecContext] (exec_context.go WithTransactionDecidedIsolated).
	inTx bool
}

func (c *scpMysqlConn) Prepare(query string) (driver.Stmt, error) { return c.base.Prepare(query) }
func (c *scpMysqlConn) Close() error                              { return c.base.Close() }
func (c *scpMysqlConn) Begin() (driver.Tx, error) {
	return c.BeginTx(context.Background(), driver.TxOptions{})
}

func (c *scpMysqlConn) BeginTx(ctx context.Context, opts driver.TxOptions) (driver.Tx, error) {
	var tx driver.Tx
	var err error
	if b, ok := c.base.(driver.ConnBeginTx); ok {
		tx, err = b.BeginTx(ctx, opts)
	} else {
		tx, err = c.base.Begin() //nolint:staticcheck
	}
	if err != nil {
		return nil, err
	}
	c.inTx = true
	return &scpMysqlTx{base: tx, conn: c}, nil
}

// scpMysqlTx clears the connection's [scpMysqlConn.inTx] when the transaction ends.
type scpMysqlTx struct {
	base driver.Tx
	conn *scpMysqlConn
}

func (t *scpMysqlTx) Commit() error {
	t.conn.inTx = false
	return t.base.Commit()
}

func (t *scpMysqlTx) Rollback() error {
	t.conn.inTx = false
	return t.base.Rollback()
}

// txControlEffect says how a tx-control statement changes the connection's transaction state:
// +1 opens one (BEGIN / START TRANSACTION), -1 ends it (COMMIT / ROLLBACK, not ROLLBACK TO a savepoint),
// 0 for anything else.
func txControlEffect(query string) int {
	head := strings.ToUpper(strings.TrimSpace(query))
	switch {
	case head == "BEGIN" || strings.HasPrefix(head, "BEGIN ") || strings.HasPrefix(head, "START TRANSACTION"):
		return 1
	case head == "COMMIT" || strings.HasPrefix(head, "COMMIT "):
		return -1
	case head == "ROLLBACK" || (strings.HasPrefix(head, "ROLLBACK ") && !strings.Contains(head, " TO ")):
		return -1
	}
	return 0
}

// atomically runs the RETURNING emulation's steps as ONE unit: inside the connection's open
// transaction, or in their own BEGIN … COMMIT (ROLLBACK when a step — the fail-closed recovery
// included — fails, so its write does not survive). The steps return MATERIALIZED rows: a live cursor
// would block the COMMIT on this connection.
func (c *scpMysqlConn) atomically(ctx context.Context, steps func() (*memRows, error)) (*memRows, error) {
	if c.inTx {
		return steps()
	}
	if _, err := c.ExecContext(ctx, "BEGIN", nil); err != nil {
		return nil, err
	}
	rows, err := steps()
	if err != nil {
		_, _ = c.ExecContext(ctx, "ROLLBACK", nil)
		return nil, err
	}
	if _, err := c.ExecContext(ctx, "COMMIT", nil); err != nil {
		return nil, err
	}
	return rows, nil
}

// QueryContext intercepts ANY write that declares a RETURNING — create/createMany, upsert, update,
// updateMany, delete — running it stripped and recovering its written rows with the SELECT
// [buildMysqlReselect] derives (id range / conflict key / batch JSON key / the write's own WHERE),
// atomically with the write. A non-RETURNING query forwards to the base driver.
func (c *scpMysqlConn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	rs, err := buildMysqlReselect(query)
	if err != nil {
		return nil, err
	}
	if rs != nil {
		return c.atomically(ctx, func() (*memRows, error) { return c.returning(ctx, rs, args) })
	}
	if q, ok := c.base.(driver.QueryerContext); ok {
		rows, err := q.QueryContext(ctx, query, args)
		if err == driver.ErrSkip {
			return c.queryViaStmt(ctx, query, args)
		}
		return rows, err
	}
	return c.queryViaStmt(ctx, query, args)
}

// returning runs one RETURNING emulation's steps (the caller makes them atomic).
func (c *scpMysqlConn) returning(ctx context.Context, rs *mysqlReselect, args []driver.NamedValue) (*memRows, error) {
	// A DELETE's rows are gone once it runs, so its recovering SELECT goes FIRST (still on this
	// connection, inside the same transaction as the delete it describes). Every other write
	// re-selects AFTER, keyed on what the write itself produced (id range / conflict key).
	if rs.before {
		rows, err := c.queryViaStmt(ctx, rs.selectSQL, bindReselect(rs.binds, args, 0, 0))
		if err != nil {
			return nil, err
		}
		pre, err := drainRows(rows)
		if err != nil {
			return nil, err
		}
		if _, _, err := c.execViaStmtWithAffected(ctx, rs.writeSQL, args); err != nil {
			return nil, err
		}
		return pre, nil
	}
	if rs.lockSQL != "" {
		// UPDATE…RETURNING: lock the rows its WHERE names and read their keys, write, then recover the
		// written rows by THOSE keys (never by the WHERE re-evaluated after the write).
		lockRows, err := c.queryViaStmt(ctx, rs.lockSQL, bindReselect(rs.lockBinds, args, 0, 0))
		if err != nil {
			return nil, err
		}
		keys, err := drainRows(lockRows)
		if err != nil {
			return nil, err
		}
		if _, _, err := c.execViaStmtWithAffected(ctx, rs.writeSQL, args); err != nil {
			return nil, err
		}
		if len(keys.rows) == 0 {
			return &memRows{cols: []string{}}, nil
		}
		keyArgs := []driver.NamedValue{}
		for _, row := range keys.rows {
			for _, v := range row {
				keyArgs = append(keyArgs, driver.NamedValue{Ordinal: len(keyArgs) + 1, Value: v})
			}
		}
		rows, err := c.queryViaStmt(ctx, keyedSelectSQL(rs, len(keys.rows)), keyArgs)
		if err != nil {
			return nil, err
		}
		recovered, err := drainRows(rows)
		if err != nil {
			return nil, err
		}
		if err := checkRecovered(len(recovered.rows), int64(len(keys.rows)), rs.writeSQL); err != nil {
			return nil, err
		}
		return recovered, nil
	}
	if rs.anchorSQL != "" {
		anchor, err := c.queryViaStmt(ctx, rs.anchorSQL, nil)
		if err != nil {
			return nil, err
		}
		if _, err := drainRows(anchor); err != nil {
			return nil, err
		}
	}
	// go-sql-driver's ExecerContext returns driver.ErrSkip for a parameterized statement (it
	// wants the prepared-statement path), so run the stripped write via a prepared statement.
	lastID, affected, err := c.execViaStmtWithAffected(ctx, rs.writeSQL, args)
	if err != nil {
		return nil, err
	}
	// A write that wrote no row (an insert-or-ignore that hit a conflict) returns nothing.
	written, err := writtenRowCount(rs.written, lastID, affected, c.foundRows, rs.writeSQL)
	if err != nil {
		return nil, err
	}
	if written == 0 {
		return &memRows{cols: []string{}}, nil
	}
	rows, err := c.queryViaStmt(ctx, rs.selectSQL, bindReselect(rs.binds, args, lastID, affected))
	if err != nil {
		return nil, err
	}
	recovered, err := drainRows(rows)
	if err != nil {
		return nil, err
	}
	if err := checkRecovered(len(recovered.rows), written, rs.writeSQL); err != nil {
		return nil, err
	}
	return recovered, nil
}

// ExecContext forwards to the base driver (writes never carry RETURNING on the exec/tx path), and
// tracks the transaction state a tx-control statement changes ([scpMysqlConn.inTx]).
func (c *scpMysqlConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	e, ok := c.base.(driver.ExecerContext)
	if !ok {
		return nil, driver.ErrSkip
	}
	res, err := e.ExecContext(ctx, query, args)
	switch effect := txControlEffect(query); {
	case effect > 0 && err == nil:
		c.inTx = true
	case effect < 0:
		// A COMMIT / ROLLBACK that errored leaves the connection in an unknown state; the runtime
		// destroys such a connection rather than reuse it.
		c.inTx = false
	}
	return res, err
}

// execViaStmtWithAffected prepares + executes a parameterized statement via the base driver's
// statement path (used for the RETURNING-emulation INSERT, which the base ExecerContext skips),
// returning the LAST_INSERT_ID and the affected-row count (for the AUTO_INCREMENT range re-select).
func (c *scpMysqlConn) execViaStmtWithAffected(ctx context.Context, query string, args []driver.NamedValue) (int64, int64, error) {
	stmt, err := c.prepareStmt(ctx, query)
	if err != nil {
		return 0, 0, err
	}
	defer stmt.Close()
	var res driver.Result
	if se, ok := stmt.(driver.StmtExecContext); ok {
		res, err = se.ExecContext(ctx, args)
	} else {
		res, err = stmt.Exec(namedToValues(args)) //nolint:staticcheck
	}
	if err != nil {
		return 0, 0, err
	}
	lastID, err := res.LastInsertId()
	if err != nil {
		return 0, 0, err
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return 0, 0, err
	}
	return lastID, affected, nil
}

// ── The MySQL RETURNING re-select derivation (the go member of the 5-language SSoT) ───────────
//
// MySQL parses no RETURNING. A write that declares one is run STRIPPED and its written rows recovered
// by a SELECT on the SAME connection — keyed on whatever identifies them. The derivation mirrors
// src/scp/makesql/mysql-returning.ts, rust livedb.rs build_mysql_reselect, python driver.py and php
// LiveDb.php exactly, so every runtime returns the same rows for the same write.

// reselectBind says how ONE `?` of the recovering SELECT is bound.
type reselectBind struct {
	kind  string // "lastId" | "highId" | "json" | "param"
	index int    // for "param": the write's own param index
}

// mysqlReselect is a write→re-select plan: the stripped write, the recovering SELECT, and its binds.
type mysqlReselect struct {
	writeSQL  string
	selectSQL string
	binds     []reselectBind
	// written says how many rows the write wrote ([writtenRowCount]): "affected" | "insertId" |
	// "affectedUnlessFoundRows", or "" when not countable (an upsert / UPDATE / DELETE).
	written string
	// anchorSQL is a consistent read run BEFORE the write in the same transaction ("" ⇒ none): a bulk
	// INSERT's AUTO_INCREMENT ids are not consecutive, and anchoring the read view first hides the rows
	// other sessions insert meanwhile from the recovering SELECT (mysql-returning.ts anchorSql).
	anchorSQL string
	// lockSQL is an UPDATE's lock-and-key step, run BEFORE the write ("" ⇒ none): `SELECT <pk> … WHERE
	// <where> … FOR UPDATE` names — and locks — exactly the rows the UPDATE is about to write (bound by
	// lockBinds). Its rows are recovered by THOSE keys: selectSQL is then the head
	// `SELECT <cols> FROM <table> WHERE (<pk>) IN ` that [keyedSelectSQL] completes.
	lockSQL   string
	lockBinds []reselectBind
	// keyCols are the key columns lockSQL reads, in order (the declared PK).
	keyCols []string
	// before runs the SELECT BEFORE the write. Only a DELETE needs it: its rows are gone once it has
	// run, so the pre-image IS the written row set.
	before bool
}

// parsePkHint extracts the PK columns + AUTO_INCREMENT column from the ` /*scp:pk=…;ai=…*/` hint
// (mysql-returning.ts mysqlPkHint). Absent hint → (nil, ""), the legacy `id`-keyed path.
func parsePkHint(returningCols string) ([]string, string) {
	hm := pkHintRe.FindStringSubmatch(returningCols)
	if hm == nil {
		return nil, ""
	}
	var cols []string
	for _, c := range strings.Split(hm[1], ",") {
		if t := strings.TrimSpace(c); t != "" {
			cols = append(cols, t)
		}
	}
	return cols, strings.TrimSpace(hm[2])
}

// parseConflictHint extracts the `;conflict=<cols>` field (the upsert conflict target). Empty ⇒ not
// an upsert.
func parseConflictHint(hintRegion string) []string {
	m := conflictHintRe.FindStringSubmatch(hintRegion)
	if m == nil {
		return nil
	}
	var cols []string
	for _, c := range strings.Split(m[1], ",") {
		if t := strings.TrimSpace(c); t != "" {
			cols = append(cols, t)
		}
	}
	return cols
}

// splitTrim splits a comma list into trimmed, non-empty entries.
func splitTrim(s string) []string {
	out := []string{}
	for _, c := range strings.Split(s, ",") {
		if t := strings.TrimSpace(c); t != "" {
			out = append(out, t)
		}
	}
	return out
}

// updateBatchKeys is EVERY JOIN key column of an updateMany — the target-side column of each
// `AND`-joined conjunct of `ON u.k1 = <v.k1> AND u.k2 = <v.k2> SET …` (json-batch.ts
// mysqlUpdateManyJson). A composite key keyed on its first column alone names rows the write never
// touched. nil ⇒ the predicate (or one of its conjuncts) does not parse.
func updateBatchKeys(writeSQL string) []string {
	m := batchJoinOnRe.FindStringSubmatch(writeSQL)
	if m == nil {
		return nil
	}
	keys := []string{}
	for _, conj := range andSplitRe.Split(m[1], -1) {
		km := batchJoinConjRe.FindStringSubmatch(strings.TrimSpace(conj))
		if km == nil {
			return nil
		}
		keys = append(keys, km[1])
	}
	return keys
}

func columnIndex(xs []string, want string) int {
	for i, x := range xs {
		if x == want {
			return i
		}
	}
	return -1
}

// buildMysqlReselect derives the RETURNING recovery for `sql`, or nil when the statement declares no
// RETURNING (the caller runs it unchanged). Fail-closed: a RETURNING write whose key cannot be
// identified is an ERROR, never a silent empty row set.
func buildMysqlReselect(sql string) (*mysqlReselect, error) {
	lower := strings.ToLower(sql)
	retPos := strings.LastIndex(lower, " returning ")
	if retPos < 0 {
		return nil, nil
	}
	hintRegion := sql[retPos:]
	cols := strings.TrimSpace(pkHintRe.ReplaceAllString(sql[retPos+len(" returning "):], ""))
	pkCols, autoInc := parsePkHint(hintRegion)
	conflict := parseConflictHint(hintRegion)
	writeSQL := strings.TrimSpace(pkHintRe.ReplaceAllString(sql[:retPos], ""))
	wl := strings.ToLower(writeSQL)

	tm := writeTableRe.FindStringSubmatch(writeSQL)
	if tm == nil {
		return nil, fmt.Errorf("scp write(mysql): cannot parse the target table of %q", writeSQL)
	}
	table := tm[1]
	orderBy := ""
	if len(pkCols) > 0 {
		orderBy = " ORDER BY " + strings.Join(pkCols, ", ")
	}
	isBatch := strings.Contains(wl, "json_table(")
	insertCols := []string{}
	if cm := insertColsRe.FindStringSubmatch(writeSQL); cm != nil {
		insertCols = splitTrim(cm[1])
	}
	// Recover a BATCH write's rows by reading its key TUPLES back out of the SAME JSON payload it bound —
	// every key column, never the first alone (a composite key's first column names other rows too).
	// The payload's fields ARE the INSERT columns, so a key column outside them would read NULL back
	// and recover nothing: that fails closed.
	jsonSelect := func(keys []string, what, written string) (*mysqlReselect, error) {
		if strings.HasPrefix(wl, "insert") {
			for _, k := range keys {
				if columnIndex(insertCols, k) < 0 {
					return nil, fmt.Errorf("scp write(mysql): %s column %q is not among the INSERT columns of %q", what, k, writeSQL)
				}
			}
		}
		unq := make([]string, len(keys))
		paths := make([]string, len(keys))
		for i, k := range keys {
			unq[i] = "JSON_UNQUOTE(jt." + k + ")"
			paths[i] = k + " JSON PATH '$." + k + "'"
		}
		return &mysqlReselect{writeSQL: writeSQL, selectSQL: fmt.Sprintf(
			"SELECT %s FROM %s WHERE (%s) IN (SELECT %s FROM JSON_TABLE(?, '$[*]' COLUMNS(%s)) jt)%s",
			cols, table, strings.Join(keys, ", "), strings.Join(unq, ", "), strings.Join(paths, ", "), orderBy,
		), binds: []reselectBind{{kind: "json"}}, written: written}, nil
	}
	// Recover a SINGLE-row INSERT's row by EVERY key column, each bound from its INSERT column position.
	keyedByInsertParams := func(keys []string, what, written string) (*mysqlReselect, error) {
		conds := []string{}
		binds := []reselectBind{}
		for _, k := range keys {
			idx := columnIndex(insertCols, k)
			if idx < 0 {
				return nil, fmt.Errorf("scp write(mysql): %s column %q is not among the INSERT columns of %q", what, k, writeSQL)
			}
			conds = append(conds, k+" = ?")
			binds = append(binds, reselectBind{kind: "param", index: idx})
		}
		return &mysqlReselect{writeSQL: writeSQL, selectSQL: fmt.Sprintf(
			"SELECT %s FROM %s WHERE %s%s", cols, table, strings.Join(conds, " AND "), orderBy,
		), binds: binds, written: written}, nil
	}
	// An insert-or-ignore is spelled `ON DUPLICATE KEY UPDATE c = c` on a single row — it reads like an
	// upsert, but it writes NOTHING on a conflict, so it is recovered as the INSERT it may have been.
	noopOnConflict := strings.Contains(wl, "on duplicate key update")
	upsert := noopOnConflict && !ignoreHintRe.MatchString(hintRegion)

	// upsert / upsertMany — by EVERY column of the CONFLICT key. MySQL does not report which row an ON
	// DUPLICATE KEY UPDATE touched, so the AUTO_INCREMENT range is wrong as soon as a row was updated.
	if strings.HasPrefix(wl, "insert") && upsert {
		if len(conflict) == 0 {
			return nil, fmt.Errorf("scp write(mysql): an upsert…RETURNING needs its conflict key in the pk hint (%q)", writeSQL)
		}
		if isBatch {
			return jsonSelect(conflict, "conflict key", "")
		}
		return keyedByInsertParams(conflict, "conflict key", "")
	}

	// create / createMany / insert-or-ignore — by the AUTO_INCREMENT range [LAST_INSERT_ID, +affected),
	// or by the client-supplied PK values pulled from the INSERT params by column position (UUID /
	// composite). Recovered only when it wrote a row, and only as many rows as it wrote ([writtenRowCount]).
	if strings.HasPrefix(wl, "insert") {
		if autoInc != "" && len(pkCols) == 1 && pkCols[0] == autoInc && isBatch {
			// createMany (a bulk INSERT…SELECT): its ids start at LAST_INSERT_ID but need not be
			// consecutive, so the bare range would name other sessions' rows and miss our own. Every id
			// it allocated is ≥ LAST_INSERT_ID; the anchored read view hides other sessions' rows; the
			// count check fails the rest closed.
			return &mysqlReselect{writeSQL: writeSQL, selectSQL: fmt.Sprintf(
				"SELECT %s FROM %s WHERE %s >= ?%s", cols, table, autoInc, orderBy,
			), binds: []reselectBind{{kind: "lastId"}}, written: "affected", anchorSQL: "SELECT 1 FROM " + table + " LIMIT 1"}, nil
		}
		if autoInc != "" && len(pkCols) == 1 && pkCols[0] == autoInc {
			// A single-row / multi-VALUES INSERT reserves its ids up front, so they ARE consecutive.
			written := "affected"
			if noopOnConflict {
				written = "insertId"
			}
			return &mysqlReselect{writeSQL: writeSQL, selectSQL: fmt.Sprintf(
				"SELECT %s FROM %s WHERE %s >= ? AND %s < ?%s", cols, table, autoInc, autoInc, orderBy,
			), binds: []reselectBind{{kind: "lastId"}, {kind: "highId"}}, written: written}, nil
		}
		if len(pkCols) == 0 {
			return nil, fmt.Errorf("scp write(mysql): an INSERT…RETURNING carries no pk hint, so its written rows cannot be identified (%q). The producer must pass the model's declared primary key", writeSQL)
		}
		// createMany with a CLIENT-supplied key: the statement binds ONE JSON payload, not one param per
		// key, so the key tuples are read back out of that SAME payload (as upsertMany does). A batch
		// `INSERT IGNORE` reads back pre-existing rows too, so its count check fails it closed.
		if isBatch {
			return jsonSelect(pkCols, "PK", "affected")
		}
		if noopOnConflict {
			return keyedByInsertParams(pkCols, "PK", "affectedUnlessFoundRows")
		}
		return keyedByInsertParams(pkCols, "PK", "affected")
	}

	// updateMany — by EVERY batch JOIN key column, re-selected from the SAME JSON payload the write bound.
	if strings.HasPrefix(wl, "update") && isBatch {
		keys := updateBatchKeys(writeSQL)
		if keys == nil {
			return nil, fmt.Errorf("scp write(mysql): cannot parse the batch JOIN key of %q", writeSQL)
		}
		return jsonSelect(keys, "JOIN key", "")
	}

	// update / delete — the rows the write's OWN WHERE predicate names, bound from the write's own
	// params. The DELETE re-selects BEFORE it, since afterwards there is nothing left to describe.
	wherePos := strings.LastIndex(wl, " where ")
	if wherePos < 0 {
		return nil, fmt.Errorf("scp write(mysql): a write…RETURNING needs a WHERE to recover its rows (%q)", writeSQL)
	}
	whereSQL := strings.TrimSpace(writeSQL[wherePos+len(" where "):])
	leading := strings.Count(writeSQL[:wherePos], "?")
	binds := []reselectBind{}
	for i := 0; i < strings.Count(whereSQL, "?"); i++ {
		binds = append(binds, reselectBind{kind: "param", index: leading + i})
	}
	if strings.HasPrefix(wl, "delete") {
		return &mysqlReselect{
			writeSQL:  writeSQL,
			selectSQL: fmt.Sprintf("SELECT %s FROM %s WHERE %s%s", cols, table, whereSQL, orderBy),
			binds:     binds,
			before:    true,
		}, nil
	}
	// The UPDATE: lock the rows its WHERE names and read their keys BEFORE the write, then recover the
	// written rows (carrying their new values) by those keys — never by the WHERE re-evaluated after it.
	if len(pkCols) == 0 {
		return nil, fmt.Errorf("scp write(mysql): an UPDATE…RETURNING carries no pk hint, so the rows it writes cannot be keyed (%q). The producer must pass the model's declared primary key", writeSQL)
	}
	return &mysqlReselect{
		writeSQL:  writeSQL,
		selectSQL: fmt.Sprintf("SELECT %s FROM %s WHERE (%s) IN ", cols, table, strings.Join(pkCols, ", ")),
		lockSQL:   fmt.Sprintf("SELECT %s FROM %s WHERE %s%s FOR UPDATE", strings.Join(pkCols, ", "), table, whereSQL, orderBy),
		lockBinds: binds,
		keyCols:   pkCols,
	}, nil
}

// keyedSelectSQL completes an UPDATE's selectSQL for `rows` locked keys (mysql-returning.ts
// keyedSelectSql): one `(?, …)` tuple per row, ordered by the declared PK.
func keyedSelectSQL(rs *mysqlReselect, rows int) string {
	marks := make([]string, len(rs.keyCols))
	for i := range marks {
		marks[i] = "?"
	}
	tuple := "(" + strings.Join(marks, ", ") + ")"
	tuples := make([]string, rows)
	for i := range tuples {
		tuples[i] = tuple
	}
	return rs.selectSQL + "(" + strings.Join(tuples, ", ") + ") ORDER BY " + strings.Join(rs.keyCols, ", ")
}

// writtenRowCount is how many rows the write wrote, from its own result (mysql-returning.ts
// writtenRowCount): "affected" — the affected count (a plain INSERT / INSERT IGNORE never updates a row,
// so CLIENT_FOUND_ROWS cannot change it); "insertId" — an insert-or-ignore on an AUTO_INCREMENT key
// inserted ⇔ its insert id is not 0; "affectedUnlessFoundRows" — the same on a client-supplied key
// inserted ⇔ 1 affected row, which CLIENT_FOUND_ROWS also reports for a conflict, so it fails closed
// there. -1 ⇒ not countable.
func writtenRowCount(written string, lastID, affected int64, foundRows bool, writeSQL string) (int64, error) {
	switch written {
	case "affected":
		return affected, nil
	case "insertId":
		if lastID != 0 {
			return 1, nil
		}
		return 0, nil
	case "affectedUnlessFoundRows":
		if foundRows {
			return 0, fmt.Errorf("scp write(mysql): an insert-or-ignore…RETURNING on a client-supplied key cannot tell an inserted row from a conflict on a CLIENT_FOUND_ROWS connection (both report 1 affected row), so it cannot name the row it wrote (%q)", writeSQL)
		}
		return affected, nil
	}
	return -1, nil
}

// checkRecovered fails closed when the recovered row count differs from the count the write wrote: the
// SELECT then named rows the write did not write (or missed ones it did).
func checkRecovered(recovered int, written int64, writeSQL string) error {
	if written >= 0 && int64(recovered) != written {
		return fmt.Errorf("scp write(mysql): the write wrote %d row(s) but its RETURNING recovery found %d — refusing to return rows it cannot attribute to this write (%q)", written, recovered, writeSQL)
	}
	return nil
}

// bindReselect binds the recovering SELECT's `?`s against the write's params + the write's result.
func bindReselect(binds []reselectBind, args []driver.NamedValue, lastID, affected int64) []driver.NamedValue {
	out := make([]driver.NamedValue, 0, len(binds))
	at := func(i int) driver.Value {
		if i >= 0 && i < len(args) {
			return args[i].Value
		}
		return nil
	}
	for _, b := range binds {
		var v driver.Value
		switch b.kind {
		case "lastId":
			v = lastID
		case "highId":
			// A write that wrote no row is never re-selected ([writtenRowCount] 0 ⇒ no rows), so
			// `affected` ≥ 1 here.
			v = lastID + affected
		case "json":
			v = at(0)
		default:
			v = at(b.index)
		}
		out = append(out, driver.NamedValue{Ordinal: len(out) + 1, Value: v})
	}
	return out
}

// drainRows materializes a driver.Rows into memory and closes it — the DELETE pre-image must be read
// BEFORE the delete runs on the same connection (a live cursor would block the write).
func drainRows(rows driver.Rows) (*memRows, error) {
	defer rows.Close()
	cols := append([]string{}, rows.Columns()...)
	var out [][]driver.Value
	for {
		buf := make([]driver.Value, len(cols))
		if err := rows.Next(buf); err != nil {
			if err == io.EOF {
				break
			}
			return nil, err
		}
		out = append(out, buf)
	}
	return &memRows{cols: cols, rows: out}, nil
}

// memRows is an in-memory driver.Rows (the drained DELETE pre-image).
type memRows struct {
	cols []string
	rows [][]driver.Value
	i    int
}

func (m *memRows) Columns() []string { return m.cols }
func (m *memRows) Close() error      { return nil }
func (m *memRows) Next(dest []driver.Value) error {
	if m.i >= len(m.rows) {
		return io.EOF
	}
	copy(dest, m.rows[m.i])
	m.i++
	return nil
}

// queryViaStmt prepares + queries a parameterized statement via the base driver's statement path.
func (c *scpMysqlConn) queryViaStmt(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	stmt, err := c.prepareStmt(ctx, query)
	if err != nil {
		return nil, err
	}
	// The statement must outlive the returned Rows; wrap so Close() releases both.
	if sq, ok := stmt.(driver.StmtQueryContext); ok {
		rows, err := sq.QueryContext(ctx, args)
		if err != nil {
			stmt.Close()
			return nil, err
		}
		return &stmtRows{Rows: rows, stmt: stmt}, nil
	}
	rows, err := stmt.Query(namedToValues(args)) //nolint:staticcheck
	if err != nil {
		stmt.Close()
		return nil, err
	}
	return &stmtRows{Rows: rows, stmt: stmt}, nil
}

func (c *scpMysqlConn) prepareStmt(ctx context.Context, query string) (driver.Stmt, error) {
	if pc, ok := c.base.(driver.ConnPrepareContext); ok {
		return pc.PrepareContext(ctx, query)
	}
	return c.base.Prepare(query)
}

func namedToValues(args []driver.NamedValue) []driver.Value {
	out := make([]driver.Value, len(args))
	for i, a := range args {
		out[i] = a.Value
	}
	return out
}

// stmtRows keeps the owning prepared statement alive for the lifetime of the rows, closing both.
type stmtRows struct {
	driver.Rows
	stmt driver.Stmt
}

func (r *stmtRows) Close() error {
	err := r.Rows.Close()
	if cerr := r.stmt.Close(); err == nil {
		err = cerr
	}
	return err
}

// Ensure the base's resource cleanup is reachable (defensive; go-sql-driver implements io.Closer).
var _ io.Closer = (*scpMysqlConn)(nil)
