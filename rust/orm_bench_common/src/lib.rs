//! The seed SSoT + connection targets shared by both rust ORM-bench cells.

/// One dialect's setup, read from `benchmark/crosslang/.setup/<dialect>.json` (emitted from
/// orm-domain.ts): `schema` = drop+create, applied once at open; `delete`+`insert` = the canonical
/// 110-user fixture as literal SQL, re-applied before each op. No cell hand-writes a schema or a seed.
pub struct Setup {
    pub schema: Vec<String>,
    pub delete: Vec<String>,
    pub insert: Vec<String>,
}

/// Read one dialect's setup. Anchored on the CALLER's manifest dir, which is `rust/<cell>/`.
pub fn load_setup(dialect: &str, manifest_dir: &str) -> Setup {
    let path = format!("{manifest_dir}/../../benchmark/crosslang/.setup/{dialect}.json");
    let txt = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read seed SSoT {path}: {e}"));
    let v: serde_json::Value =
        serde_json::from_str(&txt).unwrap_or_else(|e| panic!("parse {path}: {e}"));
    let arr = |k: &str| {
        v[k].as_array()
            .unwrap_or_else(|| panic!("{path}: `{k}` not an array"))
            .iter()
            .map(|s| s.as_str().expect("statement is a string").to_string())
            .collect::<Vec<_>>()
    };
    Setup { schema: arr("schema"), delete: arr("delete"), insert: arr("insert") }
}

fn env_or(k: &str, def: &str) -> String {
    std::env::var(k).ok().filter(|s| !s.is_empty()).unwrap_or_else(|| def.to_string())
}

/// The libpq connection string for the bench Postgres, from the same `TEST_DB_*` environment the
/// conformance live legs use. The connection target is env, never an argv-passed DSN: a second knob
/// beside the dialect is a knob the two can disagree on.
pub fn postgres_conn() -> String {
    format!(
        "host={} port={} user={} password={} dbname={}",
        env_or("TEST_DB_HOST", "localhost"),
        env_or("TEST_DB_PORT", "5433"),
        env_or("TEST_DB_USER", "testuser"),
        env_or("TEST_DB_PASSWORD", "testpass"),
        env_or("TEST_DB_NAME", "testdb")
    )
}

/// The URL for the bench MySQL, from the same `TEST_MYSQL_*` environment.
pub fn mysql_url() -> String {
    format!(
        "mysql://{}:{}@{}:{}/{}",
        env_or("TEST_MYSQL_USER", "testuser"),
        env_or("TEST_MYSQL_PASSWORD", "testpass"),
        env_or("TEST_MYSQL_HOST", "127.0.0.1"),
        env_or("TEST_MYSQL_PORT", "3307"),
        env_or("TEST_MYSQL_DB", "testdb")
    )
}
