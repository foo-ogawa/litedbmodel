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
	"testing"
)

// openMysqlReturning opens the shipped RETURNING-emulating driver on a table name unique to this run.
func openMysqlReturning(t *testing.T) (*sql.DB, string) {
	t.Helper()
	if !txIsoEnabled() {
		t.Skip("skipped (set LITEDBMODEL_TX_ISOLATION=1 + docker up: MySQL:3307)")
	}
	dsn := fmt.Sprintf("%s:%s@tcp(%s:%s)/%s",
		envOr("TEST_MYSQL_USER", "testuser"), envOr("TEST_MYSQL_PASSWORD", "testpass"),
		envOr("TEST_MYSQL_HOST", "127.0.0.1"), envOr("TEST_MYSQL_PORT", "3307"), envOr("TEST_MYSQL_DB", "testdb"))
	db, err := OpenMysql(dsn)
	if err != nil {
		t.Fatalf("mysql connect: %v", err)
	}
	tbl := fmt.Sprintf("scp_myret_go_%d", os.Getpid())
	t.Cleanup(func() {
		_, _ = db.Exec("DROP TABLE IF EXISTS " + tbl)
		_ = db.Close()
	})
	return db, tbl
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
