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
