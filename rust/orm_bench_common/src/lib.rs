//! The seed SSoT + connection targets shared by both rust ORM-bench cells.

/// One dialect's setup, read from `benchmark/crosslang/.setup/<dialect>.json` (emitted from
/// orm-domain.ts): `schema` = drop+create, applied once at open; `delete`+`insert` = the canonical
/// 110-user fixture as literal SQL, re-applied before each op. No cell hand-writes a schema or a seed.
pub struct Setup {
    pub schema: Vec<String>,
    pub delete: Vec<String>,
    pub insert: Vec<String>,
    /// The statements each op issues, in order, captured from the GENERATED module at the runtime seam
    /// (`lm_orm_native sql`). The SDK baseline executes THESE rather than hand-writing its own SQL: the
    /// report divides native by sdk, which only isolates the runtime's cost if both send the same
    /// statements. SQL is a property of the dialect, not of the language.
    pub ops: std::collections::HashMap<String, Vec<String>>,
    /// The values each op BINDS, from the axis SSoT (benchmark/crosslang/contract.ts), with `{it}`
    /// still in place — [`op_input`] resolves it per iteration. Declared rather than captured, since it
    /// is what the cells supply, and read here so neither rust cell spells a value out: two cells
    /// binding different values do different work even on identical SQL, which is exactly what a
    /// rows/op check cannot see (#172).
    pub inputs: serde_json::Value,
    /// Per op, one entry per statement in [`Setup::ops`]: the MySQL RETURNING recovery, or null where
    /// the statement needs none. Absent for PostgreSQL and SQLite, which execute the declared
    /// `RETURNING id` as written. Derived from the captured write by the library's own
    /// `buildMysqlReselect` (benchmark/crosslang/derive-ops.ts), never hand-copied.
    pub recover: serde_json::Value,
    /// Per batch-write op, the columns its statement reads. PostgreSQL's `UNNEST` binds one array PER
    /// COLUMN, so the order is the statement's; MySQL and SQLite read one JSON payload by name.
    pub batch_columns: serde_json::Value,
}

/// How ONE `?` of a recovering SELECT is bound — the vocabulary of `ReselectBind`
/// (src/scp/makesql/mysql-returning.ts).
#[derive(Clone, Debug)]
pub enum Bind {
    /// The write's own bound param at this index.
    Param(usize),
    /// `LAST_INSERT_ID()` — the first AUTO_INCREMENT id the INSERT allocated.
    LastId,
    /// That id plus `max(1, affected)` — the exclusive top of the inserted range.
    HighId,
}

/// One write's MySQL RETURNING recovery: run `write_sql` (the write with the RETURNING clause and the
/// `/*scp:pk=…*/` hint removed), then fetch `select_sql` bound per `binds`. Both together are ONE
/// logical statement — what the runtime's seam counts.
#[derive(Clone, Debug)]
pub struct Recovery {
    pub write_sql: String,
    pub select_sql: String,
    pub binds: Vec<Bind>,
}

impl Setup {
    /// `op`'s declared input scope for iteration `it`, with `{it}` — the ONE substitution the artifact
    /// carries — replaced throughout, so an op with a UNIQUE column stays insertable in a timed loop.
    pub fn op_input(&self, op: &str, it: u64) -> serde_json::Value {
        let declared = self
            .inputs
            .get(op)
            .unwrap_or_else(|| panic!("no declared inputs for op {op}"));
        resolve_it(declared, &it.to_string())
    }

    /// The recovery for statement `index` of `op`, or None where the database executes the declared
    /// RETURNING itself (every PostgreSQL and SQLite statement, and most MySQL ones).
    pub fn recovery(&self, op: &str, index: usize) -> Option<Recovery> {
        let entry = self.recover.get(op)?.get(index)?;
        if entry.is_null() {
            return None;
        }
        let binds = entry["binds"]
            .as_array()
            .unwrap_or_else(|| panic!("recovery {op}[{index}]: `binds` not an array"))
            .iter()
            .map(|b| match b["kind"].as_str() {
                Some("param") => Bind::Param(b["index"].as_u64().expect("bind index") as usize),
                Some("lastId") => Bind::LastId,
                Some("highId") => Bind::HighId,
                other => panic!("unknown recovery bind kind {other:?}"),
            })
            .collect();
        Some(Recovery {
            write_sql: entry["writeSql"].as_str().expect("writeSql").to_string(),
            select_sql: entry["selectSql"].as_str().expect("selectSql").to_string(),
            binds,
        })
    }

    /// The columns `op`'s batch statement reads, in its own order — a HARD failure when absent, since
    /// binding a batch write without the statement's column order is exactly the guess this removes.
    pub fn batch_columns(&self, op: &str) -> Vec<String> {
        self.batch_columns
            .get(op)
            .and_then(|c| c.as_array())
            .unwrap_or_else(|| panic!("no batchColumns for op {op}"))
            .iter()
            .map(|c| c.as_str().expect("column name").to_string())
            .collect()
    }
}

/// Substitute `{it}` in every string of a declared input value.
fn resolve_it(value: &serde_json::Value, it: &str) -> serde_json::Value {
    match value {
        serde_json::Value::String(s) => serde_json::Value::String(s.replace("{it}", it)),
        serde_json::Value::Array(a) => {
            serde_json::Value::Array(a.iter().map(|v| resolve_it(v, it)).collect())
        }
        serde_json::Value::Object(o) => serde_json::Value::Object(
            o.iter()
                .map(|(k, v)| (k.clone(), resolve_it(v, it)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// Read one dialect's setup. Anchored on the CALLER's manifest dir, which is `rust/<cell>/`.
pub fn load_setup(dialect: &str, manifest_dir: &str) -> Setup {
    let path = format!("{manifest_dir}/../../benchmark/crosslang/.setup/{dialect}.json");
    let txt =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read seed SSoT {path}: {e}"));
    let v: serde_json::Value =
        serde_json::from_str(&txt).unwrap_or_else(|e| panic!("parse {path}: {e}"));
    let arr = |k: &str| {
        v[k].as_array()
            .unwrap_or_else(|| panic!("{path}: `{k}` not an array"))
            .iter()
            .map(|s| s.as_str().expect("statement is a string").to_string())
            .collect::<Vec<_>>()
    };
    let ops = v["ops"]
        .as_object()
        .map(|m| {
            m.iter()
                .map(|(k, list)| {
                    let stmts = list
                        .as_array()
                        .unwrap_or_else(|| panic!("{path}: ops.{k} not an array"))
                        .iter()
                        .map(|s| s.as_str().expect("statement is a string").to_string())
                        .collect();
                    (k.clone(), stmts)
                })
                .collect()
        })
        .unwrap_or_else(|| panic!("{path}: no `ops` — run `lm_orm_native sql` for this dialect"));
    let field = |k: &str| v.get(k).cloned().unwrap_or(serde_json::Value::Null);
    Setup {
        schema: arr("schema"),
        delete: arr("delete"),
        insert: arr("insert"),
        ops,
        inputs: v
            .get("inputs")
            .cloned()
            .unwrap_or_else(|| panic!("{path}: no `inputs` — run `emit-setup.ts` for this scale")),
        // Absent on PostgreSQL and SQLite, which need no recovery; `recovery()` then reports None.
        recover: field("recover"),
        batch_columns: field("batchColumns"),
    }
}

fn env_or(k: &str, def: &str) -> String {
    std::env::var(k)
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| def.to_string())
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
