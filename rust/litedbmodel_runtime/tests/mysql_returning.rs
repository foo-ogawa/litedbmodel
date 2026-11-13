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

fn tbl() -> String {
    format!("scp_myret_rs_{}", std::process::id())
}

fn driver() -> MysqlDriver {
    common::require_live_db(GATE);
    MysqlDriver::connect(&common::mysql_url()).expect("mysql connect")
}

fn table(d: &MysqlDriver, ddl: &str, seed: &[String]) {
    let t = tbl();
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
    let t = tbl();
    let ddl = "(id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(64) NOT NULL, tenant_id INT NOT NULL, name VARCHAR(64), UNIQUE KEY uq (email, tenant_id))";
    let victim = vec![format!(
        "INSERT INTO {t} (email, tenant_id, name) VALUES ('a@x', 2, 'victim')"
    )];
    let mine = vec![vec![
        "email=a@x".to_string(),
        "tenant_id=1".to_string(),
        "name=mine".to_string(),
    ]];

    table(&d, ddl, &victim);
    let got = rows(&d, &format!("INSERT INTO {t} (email, name, tenant_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE email = VALUES(email), name = VALUES(name), tenant_id = VALUES(tenant_id) RETURNING email, tenant_id, name /*scp:pk=id;ai=id;conflict=email, tenant_id*/"), &[s("a@x"), s("mine"), Value::Int(1)]).expect("upsert");
    assert_eq!(got, mine, "upsert");

    table(&d, ddl, &victim);
    let got = rows(&d, &format!("INSERT INTO {t} (email, name, tenant_id) SELECT JSON_UNQUOTE(jt.email), JSON_UNQUOTE(jt.name), jt.tenant_id FROM JSON_TABLE(?, '$[*]' COLUMNS(email JSON PATH '$.email', name JSON PATH '$.name', tenant_id BIGINT PATH '$.tenant_id')) jt ON DUPLICATE KEY UPDATE email = VALUES(email), name = VALUES(name), tenant_id = VALUES(tenant_id) RETURNING email, tenant_id, name /*scp:pk=id;ai=id;conflict=email,tenant_id*/"), &[s(r#"[{"email":"a@x","name":"mine","tenant_id":1}]"#)]).expect("upsertMany");
    assert_eq!(got, mine, "upsertMany");

    // ON u.id = … AND u.tenant_id = …: the victim shares the FIRST key column (id) only.
    table(
        &d,
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
