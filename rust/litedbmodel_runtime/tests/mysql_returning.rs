//! MySQL has no RETURNING: the sqlx driver's emulation (`src/livedb.rs` `build_mysql_reselect` +
//! `my_all_on_conn`) must return EXACTLY the rows the write wrote — the set PG / SQLite native RETURNING
//! returns — and fail closed where it cannot know that set. Each statement below is the TS compiler's own
//! mysql output (compileWriteNode / the batch bundles), run through the shipped `MysqlDriver`.
//!
//! Gated behind LITEDBMODEL_TX_ISOLATION=1 + docker up (MySQL:3307), like the other live rust suites.
#![cfg(feature = "livedb")]

mod common;

use litedbmodel_runtime::{Driver, MysqlDriver, SqlFailure, Value, WireValue};

const GATE: &str = "LITEDBMODEL_TX_ISOLATION";

/// A table name unique to this run AND test (the tests of one binary run in parallel).
fn tbl(tag: &str) -> String {
    format!("scp_myret_rs_{tag}_{}", std::process::id())
}

fn driver() -> MysqlDriver {
    common::require_live_db(GATE);
    MysqlDriver::connect(&common::mysql_url()).expect("mysql connect")
}

fn table(d: &MysqlDriver, t: &str, ddl: &str, seed: &[String]) {
    let mut stmts = vec![
        format!("DROP TABLE IF EXISTS {t}"),
        format!("CREATE TABLE {t} {ddl}"),
    ];
    stmts.extend(seed.iter().cloned());
    d.exec_ddl(&stmts).expect("mysql table");
}

/// One row as `column=value` cells (NULL ⇒ `<nil>`), in RETURNING column order.
fn cells(v: &WireValue) -> Vec<String> {
    let WireValue::Row(r) = v else {
        panic!("not a row")
    };
    r.entries
        .iter()
        .map(|(k, v)| {
            let s = match v {
                WireValue::Str(s) => s.to_string(),
                WireValue::Int(n) => n.to_string(),
                WireValue::Float(f) => f.to_string(),
                WireValue::Bool(b) => b.to_string(),
                WireValue::Null => "<nil>".to_string(),
                _ => "[composite]".to_string(),
            };
            format!("{k}={s}")
        })
        .collect()
}

fn rows(d: &MysqlDriver, sql: &str, params: &[Value]) -> Result<Vec<Vec<String>>, SqlFailure> {
    Ok(d.prepare(sql).all(params)?.iter().map(cells).collect())
}

fn s(v: &str) -> Value {
    Value::Str(v.to_string())
}

/// #358 — a composite key is matched on EVERY column, never the first alone.
#[test]
fn mysql_returning_composite_key() {
    let d = driver();
    let t = tbl("ck");
    let ddl = "(id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(64) NOT NULL, tenant_id INT NOT NULL, name VARCHAR(64), UNIQUE KEY uq (email, tenant_id))";
    let victim = vec![format!(
        "INSERT INTO {t} (email, tenant_id, name) VALUES ('a@x', 2, 'victim')"
    )];
    let mine = vec![vec![
        "email=a@x".to_string(),
        "tenant_id=1".to_string(),
        "name=mine".to_string(),
    ]];

    table(&d, &t, ddl, &victim);
    let got = rows(&d, &format!("INSERT INTO {t} (email, name, tenant_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE email = VALUES(email), name = VALUES(name), tenant_id = VALUES(tenant_id) RETURNING email, tenant_id, name /*scp:pk=id;ai=id;conflict=email, tenant_id*/"), &[s("a@x"), s("mine"), Value::Int(1)]).expect("upsert");
    assert_eq!(got, mine, "upsert");

    table(&d, &t, ddl, &victim);
    let got = rows(&d, &format!("INSERT INTO {t} (email, name, tenant_id) SELECT JSON_UNQUOTE(jt.email), JSON_UNQUOTE(jt.name), jt.tenant_id FROM JSON_TABLE(?, '$[*]' COLUMNS(email JSON PATH '$.email', name JSON PATH '$.name', tenant_id BIGINT PATH '$.tenant_id')) jt ON DUPLICATE KEY UPDATE email = VALUES(email), name = VALUES(name), tenant_id = VALUES(tenant_id) RETURNING email, tenant_id, name /*scp:pk=id;ai=id;conflict=email,tenant_id*/"), &[s(r#"[{"email":"a@x","name":"mine","tenant_id":1}]"#)]).expect("upsertMany");
    assert_eq!(got, mine, "upsertMany");

    // ON u.id = … AND u.tenant_id = …: the victim shares the FIRST key column (id) only.
    table(
        &d,
        &t,
        "(tenant_id INT NOT NULL, id INT NOT NULL, name VARCHAR(64), PRIMARY KEY (tenant_id, id))",
        &[format!(
            "INSERT INTO {t} (tenant_id, id, name) VALUES (2, 7, 'victim')"
        )],
    );
    let got = rows(&d, &format!("UPDATE {t} AS u JOIN JSON_TABLE(?, '$[*]' COLUMNS(id BIGINT PATH '$.id', tenant_id BIGINT PATH '$.tenant_id', name JSON PATH '$.name')) AS v ON u.id = v.id AND u.tenant_id = v.tenant_id SET u.name = JSON_UNQUOTE(v.name) RETURNING tenant_id, id, name"), &[s(r#"[{"id":7,"tenant_id":1,"name":"hijack"}]"#)]).expect("updateMany");
    assert_eq!(got, Vec::<Vec<String>>::new(), "updateMany");
    d.exec_ddl(&[format!("DROP TABLE IF EXISTS {t}")])
        .expect("drop");
}

/// #359 — an insert-or-ignore returns only the row it inserted, never the conflicting row.
#[test]
fn mysql_returning_insert_ignore() {
    let d = driver();
    let t = tbl("ign");
    let none = Vec::<Vec<String>>::new();

    // AUTO_INCREMENT key: inserted ⇔ the insert id is not 0.
    table(&d, &t, "(id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(64) NOT NULL, name VARCHAR(64), UNIQUE KEY uq (email))", &[format!("INSERT INTO {t} (email, name) VALUES ('a@x', 'victim')")]);
    let ignore_auto_inc = format!("INSERT INTO {t} (email, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE email = email RETURNING email, name /*scp:pk=id;ai=id;conflict=email;action=ignore*/");
    assert_eq!(
        rows(&d, &ignore_auto_inc, &[s("a@x"), s("mine")]).expect("autoinc conflict"),
        none,
        "autoinc conflict"
    );
    assert_eq!(
        rows(&d, &ignore_auto_inc, &[s("b@x"), s("mine")]).expect("autoinc insert"),
        vec![vec!["email=b@x".to_string(), "name=mine".to_string()]],
        "autoinc insert"
    );

    // Client-supplied key: sqlx always opens with CLIENT_FOUND_ROWS, under which a conflict and an
    // insert both report 1 affected row — it cannot name the row it wrote, so it fails closed.
    let client_ddl = "(code VARCHAR(16) PRIMARY KEY, owner VARCHAR(64))";
    let victim = vec![format!(
        "INSERT INTO {t} (code, owner) VALUES ('X1', 'victim')"
    )];
    table(&d, &t, client_ddl, &victim);
    let ignore_client = format!("INSERT INTO {t} (code, owner) VALUES (?, ?) ON DUPLICATE KEY UPDATE code = code RETURNING code, owner /*scp:pk=code;ai=;conflict=code;action=ignore*/");
    let err = rows(&d, &ignore_client, &[s("X1"), s("mine")])
        .expect_err("client conflict must fail closed");
    assert!(
        format!("{err:?}").contains("CLIENT_FOUND_ROWS"),
        "client conflict: {err:?}"
    );

    // Batch (INSERT IGNORE) on a client-supplied key: the pre-existing row read back fails it closed.
    table(&d, &t, client_ddl, &victim);
    let batch = format!("INSERT IGNORE INTO {t} (code, owner) SELECT JSON_UNQUOTE(jt.code), JSON_UNQUOTE(jt.owner) FROM JSON_TABLE(?, '$[*]' COLUMNS(code JSON PATH '$.code', owner JSON PATH '$.owner')) jt RETURNING code, owner /*scp:pk=code;ai=;conflict=code;action=ignore*/");
    let err = rows(
        &d,
        &batch,
        &[s(
            r#"[{"code":"X1","owner":"mine"},{"code":"X2","owner":"mine"}]"#,
        )],
    )
    .expect_err("batch ignore with a conflict must fail closed");
    assert!(
        format!("{err:?}").contains("wrote 1 row(s) but its RETURNING recovery found 2"),
        "batch ignore: {err:?}"
    );
    assert_eq!(
        rows(&d, &batch, &[s(r#"[{"code":"X3","owner":"mine"}]"#)]).expect("batch ignore insert"),
        vec![vec!["code=X3".to_string(), "owner=mine".to_string()]],
        "batch ignore insert"
    );
    d.exec_ddl(&[format!("DROP TABLE IF EXISTS {t}")])
        .expect("drop");
}

/// Poll the server until a thread runs a statement starting with `prefix`, then let it block.
fn until_running(d: &MysqlDriver, prefix: &str) {
    for _ in 0..200 {
        let n = rows(
            d,
            "SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE INFO LIKE ?",
            &[s(&format!("{prefix}%"))],
        )
        .expect("processlist");
        if n[0][0] != "n=0" {
            std::thread::sleep(std::time::Duration::from_millis(300));
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    panic!("no thread ever ran '{prefix}…'");
}

/// #360 — a bulk INSERT…RETURNING returns its own rows, not the ids another session took between them.
#[test]
fn mysql_returning_bulk_auto_inc() {
    let d = driver();
    let t = tbl("bulk");
    let create_many = format!("INSERT INTO {t} (tenant_id, uk) SELECT jt.tenant_id, JSON_UNQUOTE(jt.uk) FROM JSON_TABLE(?, '$[*]' COLUMNS(tenant_id BIGINT PATH '$.tenant_id', uk JSON PATH '$.uk')) jt RETURNING uk, tenant_id /*scp:pk=id;ai=id*/");
    let payload = r#"[{"tenant_id":1,"uk":"k1"},{"tenant_id":1,"uk":"k2"},{"tenant_id":1,"uk":"k3"},{"tenant_id":1,"uk":"k4"}]"#;
    let mine: Vec<Vec<String>> = ["k1", "k2", "k3", "k4"]
        .iter()
        .map(|uk| vec![format!("uk={uk}"), "tenant_id=1".to_string()])
        .collect();

    // A bounded two-connection schedule: the other session holds a gap lock the bulk insert must wait
    // on, inserts its own row (taking the next id) while the bulk insert is blocked mid-way, and commits.
    table(&d, &t, "(id INT AUTO_INCREMENT PRIMARY KEY, uk VARCHAR(32) NOT NULL, tenant_id INT NOT NULL, UNIQUE KEY uq (uk))", &[format!("INSERT INTO {t} (uk, tenant_id) VALUES ('seed', 0)")]);
    let other = driver();
    let mut tx = other.begin_tx().expect("other BEGIN");
    tx.execute(
        &format!("SELECT id FROM {t} WHERE uk = 'k3' FOR UPDATE"),
        &[],
    )
    .expect("gap lock");
    let (sql, json) = (create_many.clone(), payload.to_string());
    let mine_thread = std::thread::spawn(move || rows(&driver(), &sql, &[s(&json)]));
    until_running(&d, &format!("INSERT INTO {t} "));
    tx.run(
        &format!("INSERT INTO {t} (uk, tenant_id) VALUES ('zz', 2)"),
        &[],
    )
    .expect("foreign insert");
    tx.commit().expect("other COMMIT");
    let got = mine_thread
        .join()
        .expect("createMany thread")
        .expect("createMany");
    assert_eq!(got, mine, "interleaved createMany");
    let order: Vec<String> = rows(&d, &format!("SELECT uk FROM {t} ORDER BY id"), &[])
        .expect("order")
        .into_iter()
        .map(|r| r[0].clone())
        .collect();
    assert_eq!(
        order,
        ["uk=seed", "uk=k1", "uk=zz", "uk=k2", "uk=k3", "uk=k4"],
        "the foreign row landed between the bulk insert's ids"
    );

    // A non-concurrent createMany keeps returning exactly its rows.
    table(
        &d,
        &t,
        "(id INT AUTO_INCREMENT PRIMARY KEY, uk VARCHAR(32) NOT NULL, tenant_id INT NOT NULL)",
        &[],
    );
    assert_eq!(
        rows(&d, &create_many, &[s(payload)]).expect("plain createMany"),
        mine,
        "plain createMany"
    );
    d.exec_ddl(&[format!("DROP TABLE IF EXISTS {t}")])
        .expect("drop");
}

/// #361 — an UPDATE…RETURNING returns the rows it updated, keyed before the write.
#[test]
fn mysql_returning_update_by_key() {
    let d = driver();
    let t = tbl("upd");
    table(
        &d,
        &t,
        "(id INT PRIMARY KEY, state VARCHAR(16) NOT NULL)",
        &[format!(
            "INSERT INTO {t} (id, state) VALUES (1, 'open'), (2, 'open'), (3, 'done')"
        )],
    );
    // A state transition: the SET changes the WHERE column, so the WHERE no longer matches afterwards.
    let got = rows(
        &d,
        &format!("UPDATE {t} SET state = ? WHERE state = ? RETURNING id, state /*scp:pk=id;ai=*/"),
        &[s("claimed"), s("open")],
    )
    .expect("state transition");
    assert_eq!(
        got,
        vec![
            vec!["id=1".to_string(), "state=claimed".to_string()],
            vec!["id=2".to_string(), "state=claimed".to_string()]
        ],
        "state transition"
    );
    d.exec_ddl(&[format!("DROP TABLE IF EXISTS {t}")])
        .expect("drop");
}
