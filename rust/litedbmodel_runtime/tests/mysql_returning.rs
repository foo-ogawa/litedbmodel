//! MySQL has no RETURNING: the sqlx driver's emulation (`src/livedb.rs` `build_mysql_reselect` +
//! `my_all_on_conn`) must return EXACTLY the rows the write wrote — the set PG / SQLite native RETURNING
//! returns — and fail closed where it cannot know that set. Each statement below is the TS compiler's own
//! mysql output (compileWriteNode / the batch bundles), run through the shipped `MysqlDriver`.
//!
//! Gated behind LITEDBMODEL_TX_ISOLATION=1 + docker up (MySQL:3307), like the other live rust suites.
#![cfg(feature = "livedb")]

mod common;

use litedbmodel_runtime::{
    for_driver, seam_execute, transaction, Driver, IsolationLevel, MysqlDriver, SqlFailure,
    StatementIntent, TransactionOptions, TxDialect, Value, WireValue,
};

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

    // A multi-row VALUES upsert: every row's key tuple, never the first row's alone.
    table(&d, &t, ddl, &victim);
    let got = rows(&d, &format!("INSERT INTO {t} (email, name, tenant_id) VALUES (?, ?, ?), (?, ?, ?) ON DUPLICATE KEY UPDATE email = VALUES(email), name = VALUES(name), tenant_id = VALUES(tenant_id) RETURNING email, tenant_id, name /*scp:pk=id;ai=id;conflict=email, tenant_id*/"), &[s("a@x"), s("mine"), Value::Int(1), s("b@x"), s("mine"), Value::Int(1)]).expect("multi-row upsert");
    let mut both = mine.clone();
    both.push(vec![
        "email=b@x".to_string(),
        "tenant_id=1".to_string(),
        "name=mine".to_string(),
    ]);
    assert_eq!(got, both, "multi-row upsert");

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

    // Client-supplied key: sqlx always opens with CLIENT_FOUND_ROWS, under which a no-op conflict and
    // an insert both report 1 affected row — so it is decided by its PK lock, never by that count.
    let client_ddl = "(code VARCHAR(16) PRIMARY KEY, owner VARCHAR(64))";
    let victim = vec![format!(
        "INSERT INTO {t} (code, owner) VALUES ('X1', 'victim')"
    )];
    table(&d, &t, client_ddl, &victim);
    let ignore_client = format!("INSERT INTO {t} (code, owner) VALUES (?, ?) ON DUPLICATE KEY UPDATE code = code RETURNING code, owner /*scp:pk=code;ai=;conflict=code;action=ignore*/");
    assert_eq!(
        rows(&d, &ignore_client, &[s("X2"), s("mine")]).expect("client insert"),
        vec![vec!["code=X2".to_string(), "owner=mine".to_string()]],
        "client insert"
    );
    assert_eq!(
        rows(&d, &ignore_client, &[s("X1"), s("mine")]).expect("client conflict"),
        none,
        "client conflict"
    );
    // A conflict on another unique key — the conflict key taken, or the PK taken — returns nothing.
    table(&d, &t, "(id VARCHAR(36) PRIMARY KEY, email VARCHAR(64) NOT NULL, owner VARCHAR(64), UNIQUE KEY uq (email))", &[format!("INSERT INTO {t} (id, email, owner) VALUES ('u-1', 'a@x', 'victim')")]);
    let ignore_unique = format!("INSERT INTO {t} (email, id, owner) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE email = email RETURNING id, email, owner /*scp:pk=id;ai=;conflict=email;action=ignore*/");
    assert_eq!(
        rows(&d, &ignore_unique, &[s("a@x"), s("u-2"), s("mine")]).expect("conflict key taken"),
        none,
        "conflict key taken"
    );
    assert_eq!(
        rows(&d, &ignore_unique, &[s("b@x"), s("u-1"), s("mine")]).expect("PK taken"),
        none,
        "PK taken"
    );
    assert_eq!(
        rows(&d, &ignore_unique, &[s("b@x"), s("u-3"), s("mine")]).expect("unique insert"),
        vec![vec![
            "id=u-3".to_string(),
            "email=b@x".to_string(),
            "owner=mine".to_string()
        ]],
        "unique insert"
    );

    // READ COMMITTED: another session inserts the same key while ours is in flight — its row is never
    // returned. A BEFORE INSERT trigger parks OUR insert (owner 'mine') on a row another session
    // holds, so the other session's insert of the same key lands exactly between a lock and the write.
    insert_ignore_race(&d, &t, client_ddl, &ignore_client);

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

/// #362 — a DELETE…RETURNING returns only the rows it deleted.
#[test]
fn mysql_returning_delete_locked() {
    let d = driver();
    let t = tbl("del");
    let delete = format!("DELETE FROM {t} WHERE id = ? RETURNING id, state /*scp:pk=id;ai=*/");
    table(
        &d,
        &t,
        "(id INT PRIMARY KEY, state VARCHAR(16) NOT NULL)",
        &[format!(
            "INSERT INTO {t} (id, state) VALUES (8, 'open'), (5, 'open')"
        )],
    );
    // Another session deletes the row after OUR snapshot (taken by our first consistent read): a plain
    // pre-image still sees it.
    let mut tx = d.begin_tx().expect("BEGIN");
    tx.execute(&format!("SELECT COUNT(*) FROM {t}"), &[])
        .expect("snapshot");
    d.exec_ddl(&[format!("DELETE FROM {t} WHERE id = 8")])
        .expect("other delete");
    let got: Vec<Vec<String>> = tx
        .execute(&delete, &[Value::Int(8)])
        .expect("delete returning")
        .iter()
        .map(cells)
        .collect();
    assert_eq!(got, Vec::<Vec<String>>::new(), "deleted after our snapshot");
    tx.commit().expect("COMMIT");
    // A row it did delete is returned.
    assert_eq!(
        rows(&d, &delete, &[Value::Int(5)]).expect("own delete"),
        vec![vec!["id=5".to_string(), "state=open".to_string()]],
        "own delete"
    );
    d.exec_ddl(&[format!("DROP TABLE IF EXISTS {t}")])
        .expect("drop");
}

/// #379 — a batch RETURNING compares its keys the way the write did: through the write's own JSON_TABLE
/// declaration (`k BIGINT PATH`). Re-read as the JSON_UNQUOTE string, a BIGINT key compares as DOUBLE,
/// and past 2^53 every neighbouring key in the same double matches. Each key column is UNINDEXED, so the
/// re-select scans (an index lookup would compare exactly and hide it).
#[test]
fn mysql_returning_bigint_key() {
    let d = driver();
    let t = tbl("big");
    // Our two keys 2^60+1 / 2^60+14, among 38 other-tenant rows whose keys round to the same doubles.
    let seed = |ddl: &str, ours: bool| {
        let rows: Vec<String> = (1..=40)
            .filter(|i| ours || (*i != 1 && *i != 14))
            .map(|i| {
                let tenant = if i == 1 || i == 14 { 1 } else { 2 };
                format!("INSERT INTO {t} (k, tenant_id, name) VALUES (1152921504606846976 + {i}, {tenant}, 'theirs')")
            })
            .collect();
        table(&d, &t, ddl, &rows);
    };
    let big = s(
        r#"[{"k":1152921504606846977,"name":"mine","tenant_id":1},{"k":1152921504606846990,"name":"mine","tenant_id":1}]"#,
    );
    let mut failures: Vec<String> = Vec::new();
    let mut count = |what: &str, sql: String, payload: &Value| match rows(
        &d,
        &sql,
        std::slice::from_ref(payload),
    ) {
        Ok(got) if got.len() == 2 => {}
        Ok(got) => failures.push(format!(
            "{what}: RETURNING returned {} rows, want the 2 it wrote",
            got.len()
        )),
        Err(e) => failures.push(format!("{what}: {e:?}")),
    };

    seed("(id INT AUTO_INCREMENT PRIMARY KEY, k BIGINT NOT NULL, tenant_id INT NOT NULL, name VARCHAR(64))", true);
    count("updateMany", format!("UPDATE {t} AS u JOIN JSON_TABLE(?, '$[*]' COLUMNS(k BIGINT PATH '$.k', name JSON PATH '$.name')) AS v ON u.k = v.k SET u.name = JSON_UNQUOTE(v.name) RETURNING k, tenant_id"), &big);
    // #384: the write reads each key by its OWN rule — the JSON value (no declared type), a declared
    // numeric type, or unquoted text — so the re-select must read it with the write's own expression.
    seed("(id INT AUTO_INCREMENT PRIMARY KEY, k BIGINT NOT NULL, tenant_id INT NOT NULL, name VARCHAR(64))", true);
    count("updateMany, no declared type", format!("UPDATE {t} AS u JOIN JSON_TABLE(?, '$[*]' COLUMNS(k JSON PATH '$.k', name JSON PATH '$.name')) AS v ON u.k = v.k SET u.name = JSON_UNQUOTE(v.name) RETURNING k, tenant_id"), &big);
    seed("(id INT AUTO_INCREMENT PRIMARY KEY, k BIGINT NOT NULL, tenant_id INT NOT NULL, name VARCHAR(64))", true);
    count("updateMany, declared BIGINT", format!("UPDATE {t} AS u JOIN JSON_TABLE(?, '$[*]' COLUMNS(k DECIMAL(65,30) PATH '$.k', name JSON PATH '$.name')) AS v ON u.k = v.k SET u.name = JSON_UNQUOTE(v.name) RETURNING k, tenant_id"), &big);

    seed("(id INT AUTO_INCREMENT PRIMARY KEY, k BIGINT NOT NULL, tenant_id INT NOT NULL, name VARCHAR(64))", false);
    count("upsertMany", format!("INSERT INTO {t} (k, name, tenant_id) SELECT jt.k, JSON_UNQUOTE(jt.name), jt.tenant_id FROM JSON_TABLE(?, '$[*]' COLUMNS(k BIGINT PATH '$.k', name JSON PATH '$.name', tenant_id BIGINT PATH '$.tenant_id')) jt ON DUPLICATE KEY UPDATE k = VALUES(k), name = VALUES(name), tenant_id = VALUES(tenant_id) RETURNING k, tenant_id /*scp:pk=id;ai=id;conflict=k*/"), &big);

    seed(
        "(k BIGINT NOT NULL, tenant_id INT NOT NULL, name VARCHAR(64))",
        false,
    );
    count("createMany", format!("INSERT INTO {t} (k, name, tenant_id) SELECT jt.k, JSON_UNQUOTE(jt.name), jt.tenant_id FROM JSON_TABLE(?, '$[*]' COLUMNS(k BIGINT PATH '$.k', name JSON PATH '$.name', tenant_id BIGINT PATH '$.tenant_id')) jt RETURNING k, tenant_id /*scp:pk=k;ai=*/"), &big);

    // A string (UUID) key the write reads as unquoted text.
    let uuid = |i: i32| format!("0b0d8a52-7a7e-4c43-9a8e-{i:012}");
    let seed_text = |ddl: &str, ours: bool| {
        let rows: Vec<String> = (1..=40)
            .filter(|i| ours || (*i != 1 && *i != 14))
            .map(|i| {
                let tenant = if i == 1 || i == 14 { 1 } else { 2 };
                format!(
                    "INSERT INTO {t} (k, tenant_id, name) VALUES ('{}', {tenant}, 'theirs')",
                    uuid(i)
                )
            })
            .collect();
        table(&d, &t, ddl, &rows);
    };
    let text = s(&format!(
        r#"[{{"k":"{}","name":"mine","tenant_id":1}},{{"k":"{}","name":"mine","tenant_id":1}}]"#,
        uuid(1),
        uuid(14)
    ));
    let text_ddl = "(id INT AUTO_INCREMENT PRIMARY KEY, k VARCHAR(36) NOT NULL, tenant_id INT NOT NULL, name VARCHAR(64))";
    seed_text(text_ddl, true);
    count("updateMany, UUID key", format!("UPDATE {t} AS u JOIN JSON_TABLE(?, '$[*]' COLUMNS(k JSON PATH '$.k', name JSON PATH '$.name')) AS v ON u.k = JSON_UNQUOTE(v.k) SET u.name = JSON_UNQUOTE(v.name) RETURNING k, tenant_id"), &text);
    seed_text(text_ddl, false);
    count("upsertMany, UUID key", format!("INSERT INTO {t} (k, name, tenant_id) SELECT JSON_UNQUOTE(jt.k), JSON_UNQUOTE(jt.name), jt.tenant_id FROM JSON_TABLE(?, '$[*]' COLUMNS(k JSON PATH '$.k', name JSON PATH '$.name', tenant_id BIGINT PATH '$.tenant_id')) jt ON DUPLICATE KEY UPDATE k = VALUES(k), name = VALUES(name), tenant_id = VALUES(tenant_id) RETURNING k, tenant_id /*scp:pk=id;ai=id;conflict=k*/"), &text);
    seed_text(
        "(k VARCHAR(36) NOT NULL, tenant_id INT NOT NULL, name VARCHAR(64))",
        false,
    );
    count("createMany, UUID key", format!("INSERT INTO {t} (k, name, tenant_id) SELECT JSON_UNQUOTE(jt.k), JSON_UNQUOTE(jt.name), jt.tenant_id FROM JSON_TABLE(?, '$[*]' COLUMNS(k JSON PATH '$.k', name JSON PATH '$.name', tenant_id BIGINT PATH '$.tenant_id')) jt RETURNING k, tenant_id /*scp:pk=k;ai=*/"), &text);

    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// Run the insert-or-ignore `ignore` (code, owner) for key K1 in a READ COMMITTED transaction while
/// another session inserts K1 — parked by a trigger until that other row is committed — and check that
/// the other session's row is never returned as ours.
fn insert_ignore_race(d: &MysqlDriver, t: &str, ddl: &str, ignore: &str) {
    use std::sync::mpsc;
    use std::sync::Mutex;

    let gate = format!("{t}_gate");
    table(d, t, ddl, &[]);
    d.exec_ddl(&[
        format!("DROP TABLE IF EXISTS {gate}"),
        format!("CREATE TABLE {gate} (id INT PRIMARY KEY)"),
        format!("INSERT INTO {gate} (id) VALUES (1)"),
    ])
    .expect("gate");
    // CREATE TRIGGER is refused over the prepared-statement protocol the driver speaks (1295), so it
    // goes over sqlx's text protocol on a connection of its own.
    let trigger = format!(
        "CREATE TRIGGER {t}_park BEFORE INSERT ON {t} FOR EACH ROW BEGIN \
         IF NEW.owner = 'mine' THEN SELECT id INTO @scp_park FROM {gate} WHERE id = 1 FOR UPDATE; END IF; END"
    );
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(async {
            use sqlx::Connection;
            let mut c = sqlx::MySqlConnection::connect(&common::mysql_url()).await?;
            sqlx::raw_sql(&trigger).execute(&mut c).await?;
            c.close().await
        })
        .expect("trigger");

    // The holder: a transaction that locks the gate row until it is told to commit.
    let (locked_tx, locked_rx) = mpsc::channel::<()>();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let release_rx = Mutex::new(release_rx);
    let holder_gate = gate.clone();
    let holder = std::thread::spawn(move || {
        let hd = MysqlDriver::connect(&common::mysql_url()).expect("holder connect");
        let ctx = for_driver(&hd);
        transaction(
            &ctx,
            TxDialect::Mysql,
            &TransactionOptions::default(),
            |tx| {
                seam_execute(
                    tx,
                    &format!("SELECT id FROM {holder_gate} WHERE id = 1 FOR UPDATE"),
                    &[],
                    &StatementIntent::read(),
                )?;
                let _ = locked_tx.send(());
                let _ = release_rx.lock().unwrap().recv();
                Ok(())
            },
        )
        .expect("holder commits");
    });
    locked_rx.recv().expect("the gate row is locked");

    // Ours: the insert-or-ignore, in a READ COMMITTED transaction.
    let ours_sql = ignore.to_string();
    let ours = std::thread::spawn(move || {
        let od = MysqlDriver::connect(&common::mysql_url()).expect("ours connect");
        let ctx = for_driver(&od);
        let options = TransactionOptions {
            isolation: Some(IsolationLevel::ReadCommitted),
            ..TransactionOptions::default()
        };
        transaction(&ctx, TxDialect::Mysql, &options, |tx| {
            seam_execute(
                tx,
                &ours_sql,
                &[s("K1"), s("mine")],
                &StatementIntent::write(),
            )
        })
        .map(|rows| rows.iter().map(cells).collect::<Vec<_>>())
    });

    // Ours is parked in its trigger, before its row: the other session inserts K1 and commits.
    let parked = (0..200).any(|_| {
        let n = d
            .prepare("SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE INFO LIKE 'SELECT id INTO @scp_park %'")
            .all(&[])
            .expect("processlist");
        let found = cells(&n[0]) != vec!["n=0".to_string()];
        if !found {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        found
    });
    assert!(parked, "our insert never reached its trigger");
    std::thread::sleep(std::time::Duration::from_millis(300));
    d.prepare(&format!(
        "INSERT INTO {t} (code, owner) VALUES ('K1', 'victim')"
    ))
    .run(&[])
    .expect("the other session's insert");
    release_tx.send(()).expect("release the gate");
    holder.join().expect("holder");
    let got = ours.join().expect("ours").expect("our insert-or-ignore");
    d.exec_ddl(&[format!("DROP TABLE IF EXISTS {gate}")])
        .expect("drop gate");
    assert_eq!(got, Vec::<Vec<String>>::new(), "READ COMMITTED race");
}
