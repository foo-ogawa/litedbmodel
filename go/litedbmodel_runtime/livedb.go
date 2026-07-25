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
	// An updateMany's batch JOIN key: `ON <alias>.<col> = JSON_UNQUOTE(…)`.
	batchJoinKeyRe = regexp.MustCompile(`(?is)\sON\s+[A-Za-z0-9_]*\.?([A-Za-z0-9_]+)\s*=`)
	// The strip-before-execute PK hint (mysql-returning.ts mysqlPkHint): ` /*scp:pk=cols;ai=<col|>[;conflict=cols]*/`.
	pkHintRe = regexp.MustCompile(`(?is)\s*/\*scp:pk=([^;*]*);ai=([^;*]*)[^*]*\*/`)
	// The hint's `;conflict=<cols>` field (the upsert conflict target).
	conflictHintRe = regexp.MustCompile(`(?is);conflict=([^*]*)\*/`)
)

func registerMysqlScp() {
	mysqlScpOnce.Do(func() {
		sql.Register("mysql-scp", scpMysqlDriver{base: gomysql.MySQLDriver{}})
	})
}

type scpMysqlDriver struct{ base driver.Driver }

func (d scpMysqlDriver) Open(name string) (driver.Conn, error) {
	c, err := d.base.Open(name)
	if err != nil {
		return nil, err
	}
	return &scpMysqlConn{base: c}, nil
}

// scpMysqlConn wraps a go-sql-driver connection, intercepting RETURNING queries. It forwards every
// other driver capability to the base connection.
type scpMysqlConn struct{ base driver.Conn }

func (c *scpMysqlConn) Prepare(query string) (driver.Stmt, error) { return c.base.Prepare(query) }
func (c *scpMysqlConn) Close() error                              { return c.base.Close() }
func (c *scpMysqlConn) Begin() (driver.Tx, error)                 { return c.base.Begin() } //nolint:staticcheck

func (c *scpMysqlConn) BeginTx(ctx context.Context, opts driver.TxOptions) (driver.Tx, error) {
	if b, ok := c.base.(driver.ConnBeginTx); ok {
		return b.BeginTx(ctx, opts)
	}
	return c.base.Begin() //nolint:staticcheck
}

// QueryContext intercepts ANY write that declares a RETURNING — create/createMany, upsert, update,
// updateMany, delete — running it stripped and recovering its written rows with the SELECT
// [buildMysqlReselect] derives (id range / conflict key / batch JSON key / the write's own WHERE). A
// non-RETURNING query forwards to the base driver.
func (c *scpMysqlConn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	rs, err := buildMysqlReselect(query)
	if err != nil {
		return nil, err
	}
	if rs != nil {
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
		// go-sql-driver's ExecerContext returns driver.ErrSkip for a parameterized statement (it
		// wants the prepared-statement path), so run the stripped write via a prepared statement.
		lastID, affected, err := c.execViaStmtWithAffected(ctx, rs.writeSQL, args)
		if err != nil {
			return nil, err
		}
		return c.queryViaStmt(ctx, rs.selectSQL, bindReselect(rs.binds, args, lastID, affected))
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

// ExecContext forwards to the base driver (writes never carry RETURNING on the exec/tx path).
func (c *scpMysqlConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	if e, ok := c.base.(driver.ExecerContext); ok {
		return e.ExecContext(ctx, query, args)
	}
	return nil, driver.ErrSkip
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
	lastID, _ := res.LastInsertId()
	affected, aerr := res.RowsAffected()
	if aerr != nil || affected < 1 {
		affected = 1
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

	// upsert / upsertMany — by the CONFLICT key. MySQL does not report which row an ON DUPLICATE KEY
	// UPDATE touched, so the AUTO_INCREMENT range is wrong as soon as a row was updated, not inserted.
	if strings.HasPrefix(wl, "insert") && strings.Contains(wl, "on duplicate key update") {
		if len(conflict) == 0 {
			return nil, fmt.Errorf("scp write(mysql): an upsert…RETURNING needs its conflict key in the pk hint (%q)", writeSQL)
		}
		key := conflict[0]
		if isBatch {
			return &mysqlReselect{writeSQL: writeSQL, selectSQL: fmt.Sprintf(
				"SELECT %s FROM %s WHERE %s IN (SELECT JSON_UNQUOTE(jt.%s) FROM JSON_TABLE(?, '$[*]' COLUMNS(%s JSON PATH '$.%s')) jt)%s",
				cols, table, key, key, key, key, orderBy,
			), binds: []reselectBind{{kind: "json"}}}, nil
		}
		idx := columnIndex(insertCols, key)
		if idx < 0 {
			return nil, fmt.Errorf("scp write(mysql): conflict key %q is not among the INSERT columns of %q", key, writeSQL)
		}
		return &mysqlReselect{writeSQL: writeSQL, selectSQL: fmt.Sprintf("SELECT %s FROM %s WHERE %s = ?%s", cols, table, key, orderBy),
			binds: []reselectBind{{kind: "param", index: idx}}}, nil
	}

	// create / createMany — by the AUTO_INCREMENT range [LAST_INSERT_ID, +affected), or by the
	// client-supplied PK values pulled from the INSERT params by column position (UUID / composite).
	if strings.HasPrefix(wl, "insert") {
		if autoInc != "" && len(pkCols) == 1 && pkCols[0] == autoInc {
			return &mysqlReselect{writeSQL: writeSQL, selectSQL: fmt.Sprintf(
				"SELECT %s FROM %s WHERE %s >= ? AND %s < ?%s", cols, table, autoInc, autoInc, orderBy,
			), binds: []reselectBind{{kind: "lastId"}, {kind: "highId"}}}, nil
		}
		if len(pkCols) == 0 {
			// No hint at all (the legacy auto-`id` corpus): the id range still identifies the rows.
			return &mysqlReselect{writeSQL: writeSQL, selectSQL: fmt.Sprintf(
				"SELECT %s FROM %s WHERE id >= ? AND id < ?", cols, table,
			), binds: []reselectBind{{kind: "lastId"}, {kind: "highId"}}}, nil
		}
		conds := []string{}
		binds := []reselectBind{}
		for _, pk := range pkCols {
			idx := columnIndex(insertCols, pk)
			if idx < 0 {
				return nil, fmt.Errorf("scp write(mysql): PK column %q is not among the INSERT columns of %q", pk, writeSQL)
			}
			conds = append(conds, pk+" = ?")
			binds = append(binds, reselectBind{kind: "param", index: idx})
		}
		return &mysqlReselect{writeSQL: writeSQL, selectSQL: fmt.Sprintf(
			"SELECT %s FROM %s WHERE %s%s", cols, table, strings.Join(conds, " AND "), orderBy,
		), binds: binds}, nil
	}

	// updateMany — by the batch JOIN key, re-selected from the SAME JSON payload the write bound.
	if strings.HasPrefix(wl, "update") && isBatch {
		km := batchJoinKeyRe.FindStringSubmatch(writeSQL)
		if km == nil {
			return nil, fmt.Errorf("scp write(mysql): cannot parse the batch JOIN key of %q", writeSQL)
		}
		key := km[1]
		return &mysqlReselect{writeSQL: writeSQL, selectSQL: fmt.Sprintf(
			"SELECT %s FROM %s WHERE %s IN (SELECT JSON_UNQUOTE(jt.%s) FROM JSON_TABLE(?, '$[*]' COLUMNS(%s JSON PATH '$.%s')) jt)%s",
			cols, table, key, key, key, key, orderBy,
		), binds: []reselectBind{{kind: "json"}}}, nil
	}

	// update / delete — by the write's OWN WHERE predicate, bound from the write's own params. The
	// UPDATE re-selects AFTER the write (the rows carry their new values); the DELETE re-selects
	// BEFORE it, since afterwards there is nothing left to describe.
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
	return &mysqlReselect{
		writeSQL:  writeSQL,
		selectSQL: fmt.Sprintf("SELECT %s FROM %s WHERE %s%s", cols, table, whereSQL, orderBy),
		binds:     binds,
		before:    strings.HasPrefix(wl, "delete"),
	}, nil
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
			// `max(1, affected)`, as in the four sibling ports: the range is EXCLUSIVE, so a driver
			// that reports 0 affected rows must still cover the one row the INSERT wrote.
			v = lastID + max(int64(1), affected)
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
func drainRows(rows driver.Rows) (driver.Rows, error) {
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
