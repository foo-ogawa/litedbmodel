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
	"time"
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

	// Client-supplied key: decided by its PK lock, never by the affected count — so the same on a
	// connection with CLIENT_FOUND_ROWS (a no-op conflict and an insert both report 1) as without it.
	clientDDL := "(code VARCHAR(16) PRIMARY KEY, owner VARCHAR(64))"
	victim := "INSERT INTO " + tbl + " (code, owner) VALUES ('X1', 'victim')"
	ignoreClient := "INSERT INTO " + tbl + " (code, owner) VALUES (?, ?) ON DUPLICATE KEY UPDATE code = code RETURNING code, owner /*scp:pk=code;ai=;conflict=code;action=ignore*/"
	uniqueDDL := "(id VARCHAR(36) PRIMARY KEY, email VARCHAR(64) NOT NULL, owner VARCHAR(64), UNIQUE KEY uq (email))"
	uniqueVictim := "INSERT INTO " + tbl + " (id, email, owner) VALUES ('u-1', 'a@x', 'victim')"
	ignoreUnique := "INSERT INTO " + tbl + " (email, id, owner) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE email = email RETURNING id, email, owner /*scp:pk=id;ai=;conflict=email;action=ignore*/"
	foundRows := openMysqlReturningDSN(t, "?clientFoundRows=true")
	for name, conn := range map[string]*sql.DB{"default": db, "clientFoundRows": foundRows} {
		myretTable(t, db, tbl, clientDDL, victim)
		got, err = myretRows(t, conn, ignoreClient, "X2", "mine")
		myretExpect(t, name+": client insert", got, err, []map[string]string{{"code": "X2", "owner": "mine"}})
		got, err = myretRows(t, conn, ignoreClient, "X1", "mine")
		myretExpect(t, name+": client conflict", got, err, []map[string]string{})
		// A conflict on another unique key — the conflict key taken, or the PK taken — returns nothing.
		myretTable(t, db, tbl, uniqueDDL, uniqueVictim)
		got, err = myretRows(t, conn, ignoreUnique, "a@x", "u-2", "mine")
		myretExpect(t, name+": conflict key taken", got, err, []map[string]string{})
		got, err = myretRows(t, conn, ignoreUnique, "b@x", "u-1", "mine")
		myretExpect(t, name+": PK taken", got, err, []map[string]string{})
		got, err = myretRows(t, conn, ignoreUnique, "b@x", "u-3", "mine")
		myretExpect(t, name+": unique insert", got, err, []map[string]string{{"id": "u-3", "email": "b@x", "owner": "mine"}})
	}

	// READ COMMITTED: another session inserts the same key while ours is in flight — its row is never
	// returned. A BEFORE INSERT trigger parks OUR insert (owner 'mine') on a row another session holds, so
	// the other session's insert of the same key lands exactly between a lock and the write.
	myretInsertIgnoreRace(t, db, tbl, clientDDL, ignoreClient)

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

	// A multi-row VALUES upsert: every row's key tuple, never the first row's alone.
	myretTable(t, db, tbl, ddl, victim)
	got, err = myretRows(t, db, "INSERT INTO "+tbl+" (email, name, tenant_id) VALUES (?, ?, ?), (?, ?, ?) ON DUPLICATE KEY UPDATE email = VALUES(email), name = VALUES(name), tenant_id = VALUES(tenant_id) RETURNING email, tenant_id, name /*scp:pk=id;ai=id;conflict=email, tenant_id*/", "a@x", "mine", 1, "b@x", "mine", 1)
	myretExpect(t, "multi-row upsert", got, err, []map[string]string{{"email": "a@x", "tenant_id": "1", "name": "mine"}, {"email": "b@x", "tenant_id": "1", "name": "mine"}})

	myretTable(t, db, tbl, ddl, victim)
	got, err = myretRows(t, db, "INSERT INTO "+tbl+" (email, name, tenant_id) SELECT JSON_UNQUOTE(jt.email), JSON_UNQUOTE(jt.name), jt.tenant_id FROM JSON_TABLE(?, '$[*]' COLUMNS(email JSON PATH '$.email', name JSON PATH '$.name', tenant_id BIGINT PATH '$.tenant_id')) jt ON DUPLICATE KEY UPDATE email = VALUES(email), name = VALUES(name), tenant_id = VALUES(tenant_id) RETURNING email, tenant_id, name /*scp:pk=id;ai=id;conflict=email,tenant_id*/", `[{"email":"a@x","name":"mine","tenant_id":1}]`)
	myretExpect(t, "upsertMany", got, err, mine)

	// ON u.id = … AND u.tenant_id = …: the victim shares the FIRST key column (id) only.
	myretTable(t, db, tbl, "(tenant_id INT NOT NULL, id INT NOT NULL, name VARCHAR(64), PRIMARY KEY (tenant_id, id))",
		"INSERT INTO "+tbl+" (tenant_id, id, name) VALUES (2, 7, 'victim')")
	got, err = myretRows(t, db, "UPDATE "+tbl+" AS u JOIN JSON_TABLE(?, '$[*]' COLUMNS(id BIGINT PATH '$.id', tenant_id BIGINT PATH '$.tenant_id', name JSON PATH '$.name')) AS v ON u.id = v.id AND u.tenant_id = v.tenant_id SET u.name = JSON_UNQUOTE(v.name) RETURNING tenant_id, id, name", `[{"id":7,"tenant_id":1,"name":"hijack"}]`)
	myretExpect(t, "updateMany", got, err, []map[string]string{})
}

// myretUntilRunning polls the server until a thread runs a statement starting with prefix, then lets
// it reach the lock it waits on.
func myretUntilRunning(t *testing.T, c *sql.Conn, prefix string) {
	t.Helper()
	for i := 0; i < 200; i++ {
		var n int
		if err := c.QueryRowContext(context.Background(), "SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE INFO LIKE ?", prefix+"%").Scan(&n); err != nil {
			t.Fatalf("processlist: %v", err)
		}
		if n > 0 {
			time.Sleep(300 * time.Millisecond)
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("no thread ever ran %q…", prefix)
}

// #360 — a bulk INSERT…RETURNING returns its own rows, not the ids another session took between them.
func TestMysqlReturningBulkAutoIncLive(t *testing.T) {
	db, tbl := openMysqlReturning(t)
	ctx := context.Background()
	createMany := "INSERT INTO " + tbl + " (tenant_id, uk) SELECT jt.tenant_id, JSON_UNQUOTE(jt.uk) FROM JSON_TABLE(?, '$[*]' COLUMNS(tenant_id BIGINT PATH '$.tenant_id', uk JSON PATH '$.uk')) jt RETURNING uk, tenant_id /*scp:pk=id;ai=id*/"
	mine := []map[string]string{}
	for _, uk := range []string{"k1", "k2", "k3", "k4"} {
		mine = append(mine, map[string]string{"uk": uk, "tenant_id": "1"})
	}

	// A bounded two-connection schedule: the other session holds a gap lock the bulk insert must wait
	// on, inserts its own row (taking the next id) while the bulk insert is blocked mid-way, and commits.
	myretTable(t, db, tbl, "(id INT AUTO_INCREMENT PRIMARY KEY, uk VARCHAR(32) NOT NULL, tenant_id INT NOT NULL, UNIQUE KEY uq (uk))",
		"INSERT INTO "+tbl+" (uk, tenant_id) VALUES ('seed', 0)")
	other, err := openMysqlReturningDSN(t, "").Conn(ctx)
	if err != nil {
		t.Fatalf("other conn: %v", err)
	}
	defer other.Close()
	for _, s := range []string{"BEGIN", "SELECT id FROM " + tbl + " WHERE uk = 'k3' FOR UPDATE"} {
		if _, err := other.ExecContext(ctx, s); err != nil {
			t.Fatalf("%s: %v", s, err)
		}
	}
	type result struct {
		rows []map[string]string
		err  error
	}
	done := make(chan result, 1)
	go func() {
		rows, err := myretRows(t, db, createMany, `[{"tenant_id":1,"uk":"k1"},{"tenant_id":1,"uk":"k2"},{"tenant_id":1,"uk":"k3"},{"tenant_id":1,"uk":"k4"}]`)
		done <- result{rows, err}
	}()
	myretUntilRunning(t, other, "INSERT INTO "+tbl+" ")
	for _, s := range []string{"INSERT INTO " + tbl + " (uk, tenant_id) VALUES ('zz', 2)", "COMMIT"} {
		if _, err := other.ExecContext(ctx, s); err != nil {
			t.Fatalf("%s: %v", s, err)
		}
	}
	r := <-done
	myretExpect(t, "interleaved createMany", r.rows, r.err, mine)
	order, err := myretRows(t, db, "SELECT uk FROM "+tbl+" ORDER BY id")
	myretExpect(t, "id order (the foreign row landed between the bulk insert's ids)", order, err,
		[]map[string]string{{"uk": "seed"}, {"uk": "k1"}, {"uk": "zz"}, {"uk": "k2"}, {"uk": "k3"}, {"uk": "k4"}})

	// A non-concurrent createMany keeps returning exactly its rows.
	myretTable(t, db, tbl, "(id INT AUTO_INCREMENT PRIMARY KEY, uk VARCHAR(32) NOT NULL, tenant_id INT NOT NULL)")
	got, err := myretRows(t, db, createMany, `[{"tenant_id":1,"uk":"k1"},{"tenant_id":1,"uk":"k2"},{"tenant_id":1,"uk":"k3"},{"tenant_id":1,"uk":"k4"}]`)
	myretExpect(t, "plain createMany", got, err, mine)
}

// #361 — an UPDATE…RETURNING returns the rows it updated, keyed before the write.
func TestMysqlReturningUpdateByKeyLive(t *testing.T) {
	db, tbl := openMysqlReturning(t)
	myretTable(t, db, tbl, "(id INT PRIMARY KEY, state VARCHAR(16) NOT NULL)",
		"INSERT INTO "+tbl+" (id, state) VALUES (1, 'open'), (2, 'open'), (3, 'done')")
	// A state transition: the SET changes the WHERE column, so the WHERE no longer matches afterwards.
	got, err := myretRows(t, db, "UPDATE "+tbl+" SET state = ? WHERE state = ? RETURNING id, state /*scp:pk=id;ai=*/", "claimed", "open")
	myretExpect(t, "state transition", got, err, []map[string]string{{"id": "1", "state": "claimed"}, {"id": "2", "state": "claimed"}})
}

// #362 — a DELETE…RETURNING returns only the rows it deleted.
func TestMysqlReturningDeleteLockedLive(t *testing.T) {
	db, tbl := openMysqlReturning(t)
	ctx := context.Background()
	ddl := "(id INT PRIMARY KEY, state VARCHAR(16) NOT NULL)"
	del := "DELETE FROM " + tbl + " WHERE id = ? RETURNING id, state /*scp:pk=id;ai=*/"
	none := []map[string]string{}

	// Another session deletes the row after OUR snapshot: a plain pre-image still sees it.
	myretTable(t, db, tbl, ddl, "INSERT INTO "+tbl+" (id, state) VALUES (8, 'open')")
	mine, err := db.Conn(ctx)
	if err != nil {
		t.Fatalf("conn: %v", err)
	}
	defer mine.Close()
	if _, err := mine.ExecContext(ctx, "START TRANSACTION WITH CONSISTENT SNAPSHOT"); err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if _, err := openMysqlReturningDSN(t, "").Exec("DELETE FROM " + tbl + " WHERE id = 8"); err != nil {
		t.Fatalf("other delete: %v", err)
	}
	got, err := myretRows(t, mine, del, 8)
	myretExpect(t, "deleted after our snapshot", got, err, none)
	if _, err := mine.ExecContext(ctx, "COMMIT"); err != nil {
		t.Fatalf("commit: %v", err)
	}

	// Another session deletes the row first and holds it; we wait on its lock, then it commits.
	myretTable(t, db, tbl, ddl, "INSERT INTO "+tbl+" (id, state) VALUES (1, 'open')")
	other, err := openMysqlReturningDSN(t, "").Conn(ctx)
	if err != nil {
		t.Fatalf("other conn: %v", err)
	}
	defer other.Close()
	for _, s := range []string{"BEGIN", "DELETE FROM " + tbl + " WHERE id = 1"} {
		if _, err := other.ExecContext(ctx, s); err != nil {
			t.Fatalf("%s: %v", s, err)
		}
	}
	type result struct {
		rows []map[string]string
		err  error
	}
	done := make(chan result, 1)
	go func() {
		rows, err := myretRows(t, db, del, 1)
		done <- result{rows, err}
	}()
	// Ours is blocked on row 1: at the locking pre-image (fixed), or at the DELETE after an unlocked one.
	for i := 0; ; i++ {
		var n int
		if err := other.QueryRowContext(ctx, "SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE INFO LIKE ? OR INFO LIKE ?", "SELECT id, state FROM "+tbl+" %", "DELETE FROM "+tbl+" %").Scan(&n); err != nil {
			t.Fatalf("processlist: %v", err)
		}
		if n > 0 {
			time.Sleep(300 * time.Millisecond)
			break
		}
		if i > 200 {
			t.Fatalf("our DELETE never ran")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if _, err := other.ExecContext(ctx, "COMMIT"); err != nil {
		t.Fatalf("other commit: %v", err)
	}
	r := <-done
	myretExpect(t, "deleted first by another session", r.rows, r.err, none)

	// A row it did delete is returned.
	myretTable(t, db, tbl, ddl, "INSERT INTO "+tbl+" (id, state) VALUES (5, 'open')")
	got, err = myretRows(t, db, del, 5)
	myretExpect(t, "own delete", got, err, []map[string]string{{"id": "5", "state": "open"}})
}

// #379 — a batch RETURNING compares its keys the way the write did: through the write's own JSON_TABLE
// declaration (k BIGINT PATH). Re-read as the JSON_UNQUOTE string, a BIGINT key compares as DOUBLE, and
// past 2^53 every neighbouring key in the same double matches. Each key column is UNINDEXED, so the
// re-select scans (an index lookup would compare exactly and hide it).
func TestMysqlReturningBigintKeyLive(t *testing.T) {
	db, tbl := openMysqlReturning(t)
	// Our two keys 2^60+1 / 2^60+14, among 38 other-tenant rows whose keys round to the same doubles.
	seed := func(ddl string, ours bool) {
		stmts := []string{}
		for i := 1; i <= 40; i++ {
			mine := i == 1 || i == 14
			if mine && !ours {
				continue
			}
			tenant := 2
			if mine {
				tenant = 1
			}
			stmts = append(stmts, fmt.Sprintf("INSERT INTO %s (k, tenant_id, name) VALUES (1152921504606846976 + %d, %d, 'theirs')", tbl, i, tenant))
		}
		myretTable(t, db, tbl, ddl, stmts...)
	}
	payload := `[{"k":1152921504606846977,"name":"mine","tenant_id":1},{"k":1152921504606846990,"name":"mine","tenant_id":1}]` // reassigned for the UUID cases
	count := func(what, sql string) {
		t.Helper()
		got, err := myretRows(t, db, sql, payload)
		if err != nil {
			t.Errorf("%s: %v", what, err)
		} else if len(got) != 2 {
			t.Errorf("%s: RETURNING returned %d rows, want the 2 it wrote", what, len(got))
		}
	}

	seed("(id INT AUTO_INCREMENT PRIMARY KEY, k BIGINT NOT NULL, tenant_id INT NOT NULL, name VARCHAR(64))", true)
	count("updateMany", "UPDATE "+tbl+" AS u JOIN JSON_TABLE(?, '$[*]' COLUMNS(k BIGINT PATH '$.k', name JSON PATH '$.name')) AS v ON u.k = v.k SET u.name = JSON_UNQUOTE(v.name) RETURNING k, tenant_id")
	// #384: the write reads each key by its OWN rule — the JSON value (no declared type), a declared
	// numeric type, or unquoted text — so the re-select must read it with the write's own expression.
	seed("(id INT AUTO_INCREMENT PRIMARY KEY, k BIGINT NOT NULL, tenant_id INT NOT NULL, name VARCHAR(64))", true)
	count("updateMany, no declared type", "UPDATE "+tbl+" AS u JOIN JSON_TABLE(?, '$[*]' COLUMNS(k JSON PATH '$.k', name JSON PATH '$.name')) AS v ON u.k = v.k SET u.name = JSON_UNQUOTE(v.name) RETURNING k, tenant_id")
	seed("(id INT AUTO_INCREMENT PRIMARY KEY, k BIGINT NOT NULL, tenant_id INT NOT NULL, name VARCHAR(64))", true)
	count("updateMany, declared BIGINT", "UPDATE "+tbl+" AS u JOIN JSON_TABLE(?, '$[*]' COLUMNS(k DECIMAL(65,30) PATH '$.k', name JSON PATH '$.name')) AS v ON u.k = v.k SET u.name = JSON_UNQUOTE(v.name) RETURNING k, tenant_id")

	seed("(id INT AUTO_INCREMENT PRIMARY KEY, k BIGINT NOT NULL, tenant_id INT NOT NULL, name VARCHAR(64))", false)
	count("upsertMany", "INSERT INTO "+tbl+" (k, name, tenant_id) SELECT jt.k, JSON_UNQUOTE(jt.name), jt.tenant_id FROM JSON_TABLE(?, '$[*]' COLUMNS(k BIGINT PATH '$.k', name JSON PATH '$.name', tenant_id BIGINT PATH '$.tenant_id')) jt ON DUPLICATE KEY UPDATE k = VALUES(k), name = VALUES(name), tenant_id = VALUES(tenant_id) RETURNING k, tenant_id /*scp:pk=id;ai=id;conflict=k*/")

	seed("(k BIGINT NOT NULL, tenant_id INT NOT NULL, name VARCHAR(64))", false)
	count("createMany", "INSERT INTO "+tbl+" (k, name, tenant_id) SELECT jt.k, JSON_UNQUOTE(jt.name), jt.tenant_id FROM JSON_TABLE(?, '$[*]' COLUMNS(k BIGINT PATH '$.k', name JSON PATH '$.name', tenant_id BIGINT PATH '$.tenant_id')) jt RETURNING k, tenant_id /*scp:pk=k;ai=*/")

	// A string (UUID) key the write reads as unquoted text.
	uuid := func(i int) string { return fmt.Sprintf("0b0d8a52-7a7e-4c43-9a8e-%012d", i) }
	seedText := func(ddl string, ours bool) {
		stmts := []string{}
		for i := 1; i <= 40; i++ {
			mine := i == 1 || i == 14
			if mine && !ours {
				continue
			}
			tenant := 2
			if mine {
				tenant = 1
			}
			stmts = append(stmts, fmt.Sprintf("INSERT INTO %s (k, tenant_id, name) VALUES ('%s', %d, 'theirs')", tbl, uuid(i), tenant))
		}
		myretTable(t, db, tbl, ddl, stmts...)
	}
	payload = fmt.Sprintf(`[{"k":%q,"name":"mine","tenant_id":1},{"k":%q,"name":"mine","tenant_id":1}]`, uuid(1), uuid(14))
	textDDL := "(id INT AUTO_INCREMENT PRIMARY KEY, k VARCHAR(36) NOT NULL, tenant_id INT NOT NULL, name VARCHAR(64))"
	seedText(textDDL, true)
	count("updateMany, UUID key", "UPDATE "+tbl+" AS u JOIN JSON_TABLE(?, '$[*]' COLUMNS(k JSON PATH '$.k', name JSON PATH '$.name')) AS v ON u.k = JSON_UNQUOTE(v.k) SET u.name = JSON_UNQUOTE(v.name) RETURNING k, tenant_id")
	seedText(textDDL, false)
	count("upsertMany, UUID key", "INSERT INTO "+tbl+" (k, name, tenant_id) SELECT JSON_UNQUOTE(jt.k), JSON_UNQUOTE(jt.name), jt.tenant_id FROM JSON_TABLE(?, '$[*]' COLUMNS(k JSON PATH '$.k', name JSON PATH '$.name', tenant_id BIGINT PATH '$.tenant_id')) jt ON DUPLICATE KEY UPDATE k = VALUES(k), name = VALUES(name), tenant_id = VALUES(tenant_id) RETURNING k, tenant_id /*scp:pk=id;ai=id;conflict=k*/")
	seedText("(k VARCHAR(36) NOT NULL, tenant_id INT NOT NULL, name VARCHAR(64))", false)
	count("createMany, UUID key", "INSERT INTO "+tbl+" (k, name, tenant_id) SELECT JSON_UNQUOTE(jt.k), JSON_UNQUOTE(jt.name), jt.tenant_id FROM JSON_TABLE(?, '$[*]' COLUMNS(k JSON PATH '$.k', name JSON PATH '$.name', tenant_id BIGINT PATH '$.tenant_id')) jt RETURNING k, tenant_id /*scp:pk=k;ai=*/")
}

// myretInsertIgnoreRace runs the insert-or-ignore `ignore` (code, owner) for key K1 under READ COMMITTED
// while another session inserts K1 — parked by a trigger until that other row is committed — and checks
// that the other session's row is never returned as ours.
func myretInsertIgnoreRace(t *testing.T, db *sql.DB, tbl, ddl, ignore string) {
	t.Helper()
	ctx := context.Background()
	gate := tbl + "_gate"
	myretTable(t, db, tbl, ddl)
	myretTable(t, db, gate, "(id INT PRIMARY KEY)", "INSERT INTO "+gate+" (id) VALUES (1)")
	t.Cleanup(func() { _, _ = db.Exec("DROP TABLE IF EXISTS " + gate) })
	if _, err := db.Exec("CREATE TRIGGER " + tbl + "_park BEFORE INSERT ON " + tbl + " FOR EACH ROW BEGIN " +
		"IF NEW.owner = 'mine' THEN SELECT id INTO @scp_park FROM " + gate + " WHERE id = 1 FOR UPDATE; END IF; END"); err != nil {
		t.Fatalf("trigger: %v", err)
	}
	holder, err := db.Conn(ctx)
	if err != nil {
		t.Fatalf("holder: %v", err)
	}
	defer holder.Close()
	ours, err := db.Conn(ctx)
	if err != nil {
		t.Fatalf("ours: %v", err)
	}
	defer func() {
		_, _ = ours.ExecContext(ctx, "SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ")
		ours.Close()
	}()
	for _, q := range []string{"BEGIN", "SELECT id FROM " + gate + " WHERE id = 1 FOR UPDATE"} {
		if _, err := holder.ExecContext(ctx, q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	if _, err := ours.ExecContext(ctx, "SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED"); err != nil {
		t.Fatalf("isolation: %v", err)
	}
	type result struct {
		rows []map[string]string
		err  error
	}
	done := make(chan result, 1)
	go func() {
		rows, err := myretRows(t, ours, ignore, "K1", "mine")
		done <- result{rows, err}
	}()
	myretUntilRunning(t, holder, "SELECT id INTO @scp_park ") // ours: parked in its trigger, before its row
	if _, err := db.Exec("INSERT INTO " + tbl + " (code, owner) VALUES ('K1', 'victim')"); err != nil {
		t.Fatalf("other session's insert: %v", err)
	}
	if _, err := holder.ExecContext(ctx, "COMMIT"); err != nil {
		t.Fatalf("COMMIT: %v", err)
	}
	r := <-done
	myretExpect(t, "READ COMMITTED race", r.rows, r.err, []map[string]string{})
}
