// MySQL has no RETURNING: the "mysql-scp" driver wrapper (livedb.go buildMysqlReselect +
// scpMysqlConn.QueryContext) must return EXACTLY the rows the write wrote — the set PG / SQLite native
// RETURNING returns — and fail closed where it cannot know that set. Each statement below is the TS
// compiler's own mysql output (compileWriteNode / the batch bundles), run through the shipped driver.
//
// Gated behind LITEDBMODEL_TX_ISOLATION=1 + docker up (MySQL:3307), like the other live go suites.
package litedbmodel_runtime

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
)

// openMysqlReturning opens the shipped RETURNING-emulating driver on a table name unique to this run.
func openMysqlReturning(t *testing.T) (*sql.DB, string) {
	t.Helper()
	db := openMysqlReturningDSN(t, "")
	tbl := fmt.Sprintf("scp_myret_go_%d", os.Getpid())
	t.Cleanup(func() { _, _ = db.Exec("DROP TABLE IF EXISTS " + tbl) })
	return db, tbl
}

// openMysqlReturningDSN opens the shipped driver with extra DSN parameters (e.g. "?clientFoundRows=true").
func openMysqlReturningDSN(t *testing.T, params string) *sql.DB {
	t.Helper()
	if !txIsoEnabled() {
		t.Skip("skipped (set LITEDBMODEL_TX_ISOLATION=1 + docker up: MySQL:3307)")
	}
	dsn := fmt.Sprintf("%s:%s@tcp(%s:%s)/%s%s",
		envOr("TEST_MYSQL_USER", "testuser"), envOr("TEST_MYSQL_PASSWORD", "testpass"),
		envOr("TEST_MYSQL_HOST", "127.0.0.1"), envOr("TEST_MYSQL_PORT", "3307"), envOr("TEST_MYSQL_DB", "testdb"), params)
	db, err := OpenMysql(dsn)
	if err != nil {
		t.Fatalf("mysql connect: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

// #359 — an insert-or-ignore returns only the row it inserted, never the conflicting row.
func TestMysqlReturningInsertIgnoreLive(t *testing.T) {
	db, tbl := openMysqlReturning(t)

	// AUTO_INCREMENT key: inserted ⇔ the insert id is not 0.
	myretTable(t, db, tbl, "(id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(64) NOT NULL, name VARCHAR(64), UNIQUE KEY uq (email))",
		"INSERT INTO "+tbl+" (email, name) VALUES ('a@x', 'victim')")
	ignoreAutoInc := "INSERT INTO " + tbl + " (email, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE email = email RETURNING email, name /*scp:pk=id;ai=id;conflict=email;action=ignore*/"
	got, err := myretRows(t, db, ignoreAutoInc, "a@x", "mine")
	myretExpect(t, "autoinc conflict", got, err, []map[string]string{})
	got, err = myretRows(t, db, ignoreAutoInc, "b@x", "mine")
	myretExpect(t, "autoinc insert", got, err, []map[string]string{{"email": "b@x", "name": "mine"}})

	// Client-supplied key without CLIENT_FOUND_ROWS (go-sql-driver's default): inserted ⇔ 1 affected row.
	clientDDL := "(code VARCHAR(16) PRIMARY KEY, owner VARCHAR(64))"
	victim := "INSERT INTO " + tbl + " (code, owner) VALUES ('X1', 'victim')"
	ignoreClient := "INSERT INTO " + tbl + " (code, owner) VALUES (?, ?) ON DUPLICATE KEY UPDATE code = code RETURNING code, owner /*scp:pk=code;ai=;conflict=code;action=ignore*/"
	myretTable(t, db, tbl, clientDDL, victim)
	got, err = myretRows(t, db, ignoreClient, "X1", "mine")
	myretExpect(t, "client conflict", got, err, []map[string]string{})
	got, err = myretRows(t, db, ignoreClient, "X2", "mine")
	myretExpect(t, "client insert", got, err, []map[string]string{{"code": "X2", "owner": "mine"}})

	// …and with CLIENT_FOUND_ROWS a conflict and an insert both report 1 affected row: fail closed.
	foundRows := openMysqlReturningDSN(t, "?clientFoundRows=true")
	myretTable(t, db, tbl, clientDDL, victim)
	if _, err := myretRows(t, foundRows, ignoreClient, "X1", "mine"); err == nil || !strings.Contains(err.Error(), "CLIENT_FOUND_ROWS") {
		t.Fatalf("client conflict on a CLIENT_FOUND_ROWS connection: err = %v, want a fail-closed CLIENT_FOUND_ROWS error", err)
	}

	// Batch (INSERT IGNORE) on a client-supplied key: the pre-existing row read back fails it closed.
	myretTable(t, db, tbl, clientDDL, victim)
	batch := "INSERT IGNORE INTO " + tbl + " (code, owner) SELECT JSON_UNQUOTE(jt.code), JSON_UNQUOTE(jt.owner) FROM JSON_TABLE(?, '$[*]' COLUMNS(code JSON PATH '$.code', owner JSON PATH '$.owner')) jt RETURNING code, owner /*scp:pk=code;ai=;conflict=code;action=ignore*/"
	if _, err := myretRows(t, db, batch, `[{"code":"X1","owner":"mine"},{"code":"X2","owner":"mine"}]`); err == nil || !strings.Contains(err.Error(), "wrote 1 row(s) but its RETURNING recovery found 2") {
		t.Fatalf("batch ignore with a conflict: err = %v, want a fail-closed count mismatch", err)
	}
	got, err = myretRows(t, db, batch, `[{"code":"X3","owner":"mine"}]`)
	myretExpect(t, "batch ignore insert", got, err, []map[string]string{{"code": "X3", "owner": "mine"}})
}

func myretTable(t *testing.T, db *sql.DB, tbl, ddl string, seed ...string) {
	t.Helper()
	for _, s := range append([]string{"DROP TABLE IF EXISTS " + tbl, "CREATE TABLE " + tbl + " " + ddl}, seed...) {
		if _, err := db.Exec(s); err != nil {
			t.Fatalf("%s: %v", s, err)
		}
	}
}

// myretRows runs one statement through the driver and reads every row as column → string (NULL ⇒ "<nil>").
func myretRows(t *testing.T, q interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}, query string, args ...any) ([]map[string]string, error) {
	t.Helper()
	rows, err := q.QueryContext(context.Background(), query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols, _ := rows.Columns()
	out := []map[string]string{}
	for rows.Next() {
		cells := make([]sql.NullString, len(cols))
		ptrs := make([]any, len(cols))
		for i := range cells {
			ptrs[i] = &cells[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		row := map[string]string{}
		for i, c := range cols {
			if cells[i].Valid {
				row[c] = cells[i].String
			} else {
				row[c] = "<nil>"
			}
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

func myretExpect(t *testing.T, label string, got []map[string]string, err error, want []map[string]string) {
	t.Helper()
	if err != nil {
		t.Fatalf("%s: %v", label, err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%s: RETURNING rows = %v, want %v", label, got, want)
	}
}

// #358 — a composite key is matched on EVERY column, never the first alone.
func TestMysqlReturningCompositeKeyLive(t *testing.T) {
	db, tbl := openMysqlReturning(t)
	ddl := "(id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(64) NOT NULL, tenant_id INT NOT NULL, name VARCHAR(64), UNIQUE KEY uq (email, tenant_id))"
	victim := "INSERT INTO " + tbl + " (email, tenant_id, name) VALUES ('a@x', 2, 'victim')"
	mine := []map[string]string{{"email": "a@x", "tenant_id": "1", "name": "mine"}}

	myretTable(t, db, tbl, ddl, victim)
	got, err := myretRows(t, db, "INSERT INTO "+tbl+" (email, name, tenant_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE email = VALUES(email), name = VALUES(name), tenant_id = VALUES(tenant_id) RETURNING email, tenant_id, name /*scp:pk=id;ai=id;conflict=email, tenant_id*/", "a@x", "mine", 1)
	myretExpect(t, "upsert", got, err, mine)

	myretTable(t, db, tbl, ddl, victim)
	got, err = myretRows(t, db, "INSERT INTO "+tbl+" (email, name, tenant_id) SELECT JSON_UNQUOTE(jt.email), JSON_UNQUOTE(jt.name), jt.tenant_id FROM JSON_TABLE(?, '$[*]' COLUMNS(email JSON PATH '$.email', name JSON PATH '$.name', tenant_id BIGINT PATH '$.tenant_id')) jt ON DUPLICATE KEY UPDATE email = VALUES(email), name = VALUES(name), tenant_id = VALUES(tenant_id) RETURNING email, tenant_id, name /*scp:pk=id;ai=id;conflict=email,tenant_id*/", `[{"email":"a@x","name":"mine","tenant_id":1}]`)
	myretExpect(t, "upsertMany", got, err, mine)

	// ON u.id = … AND u.tenant_id = …: the victim shares the FIRST key column (id) only.
	myretTable(t, db, tbl, "(tenant_id INT NOT NULL, id INT NOT NULL, name VARCHAR(64), PRIMARY KEY (tenant_id, id))",
		"INSERT INTO "+tbl+" (tenant_id, id, name) VALUES (2, 7, 'victim')")
	got, err = myretRows(t, db, "UPDATE "+tbl+" AS u JOIN JSON_TABLE(?, '$[*]' COLUMNS(id BIGINT PATH '$.id', tenant_id BIGINT PATH '$.tenant_id', name JSON PATH '$.name')) AS v ON u.id = v.id AND u.tenant_id = v.tenant_id SET u.name = JSON_UNQUOTE(v.name) RETURNING tenant_id, id, name", `[{"id":7,"tenant_id":1,"name":"hijack"}]`)
	myretExpect(t, "updateMany", got, err, []map[string]string{})
}
