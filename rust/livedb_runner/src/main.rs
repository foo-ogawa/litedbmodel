// litedbmodel SCP LIVE-DB conformance — the Rust leg (#36 WS7g; leaf/emitter cutover #141, #163).
//
// What runs here is the module bc GENERATED for this language from the SAME declaration the TS leg
// runs (conformance/harness.ts → emitBehaviorModule → `bc generate --lang rust-typed-native`, one
// module per live dialect in `src/gen/<dialect>.rs`, written by conformance/gen-livedb.ts). Nothing
// is replayed from a serialized bundle: a leaf-executed module needs a LIVE in-process handle, which
// is why the recorder-era bundle-replay model is gone.
//
// The ONLY hand-wiring is what makes the generated modules callable as a HARNESS (CLAUDE.md §3.1): the
// leaf transport (`execute_sql`) resolves the ambient driver a `with_ambient_driver` scope installs, so
// each entry is invoked by its SIGNATURE inside that scope; the `callEntry` switch is the sanctioned
// signature-direct call table on `vector.entry`, not a per-endpoint exec seam.
//
// Every vector is compared against what the TS leg observed on the SAME server for the SAME dialect
// (conformance/vectors-livedb/livedb.json): the ORDERED statements the leaf handed the driver (captured
// at the driver contact point via a thin tap Driver — the SAME layer the python `_TapDriver` taps), the
// FULL nested typed result (relation children and their field VALUES included — a row count is not a
// check, #150), and the resulting DB state for a write.
//
// REAL DBs, no mock, NO silent skip: if PG or MySQL is unreachable this ERRORS OUT LOUDLY (exit 3).
// Emits the machine-readable JSON summary the orchestrator expects as its LAST stdout line:
//
//   {"lang":"rust-livedb","suites":{"livedb-pg":{..},"livedb-mysql":{..}},"total_pass",...}
//
// Exit: 0 all pass, 1 any fail, 2 corpus-version mismatch / usage, 3 DB unreachable.

// The live-DB drivers (PostgresDriver / MysqlDriver) are behind the runtime's `livedb` feature, so the
// runner is only meaningful with `--features livedb` (the LEGS invocation always passes it, and the
// SQLite conformance bar keeps the runner out of the default build). Without it, fail LOUDLY.
#[cfg(not(feature = "livedb"))]
fn main() {
    eprintln!("FATAL: livedb_runner must be built with --features livedb");
    std::process::exit(2);
}

// The bc-generated covered modules, one per live dialect (emitter OUTPUT — never hand-edited). The
// nested relation outTypes bc names `Row_child` are non-camel-case TYPES, and the covered de-box is not
// this runner's code to lint, so the generated tree is held OUT of the runner's lint gate here.
#[cfg(feature = "livedb")]
#[allow(
    non_camel_case_types,
    non_snake_case,
    dead_code,
    clippy::all,
    clippy::pedantic
)]
mod gen {
    pub mod mysql;
    pub mod postgres;
}

#[cfg(feature = "livedb")]
fn main() {
    std::process::exit(imp::run());
}

#[cfg(feature = "livedb")]
mod imp {
    use std::cell::RefCell;

    use litedbmodel_runtime::{
        with_ambient_driver, BehaviorError, Driver, MysqlDriver, PostgresDriver, PreparedStatement,
        RunInfo, SessionConnection, SqlFailure, TxConnection, Value, WireValue,
    };
    use serde_json::{Map, Number, Value as J};

    use crate::gen::{mysql as my, postgres as pg};

    /// The corpus schema version this leg supports (harness CORPUS_VERSION — fail-closed on a mismatch,
    /// exactly as the python/php/go legs do).
    const SUPPORTED_CORPUS_VERSION: i64 = 5;

    // ── canonical comparison ────────────────────────────────────────────────────────────────────────
    //
    // Two NUMERIC REPRESENTATIONS of one declared type are folded, and nothing else — a differing VALUE
    // still compares unequal (the SAME rule as the python `_canon` / php `canonical` / go `canon`):
    //   - {"$bigint":"N"} (how the TS reference encodes a bc `int` cell for JSON) folds to the integer N;
    //   - an INTEGRAL float (a JS `number` for an int32 column, or a driver-scanned INTEGER cell) folds
    //     to the integer it denotes. 10.5 still differs from 10.
    // Object keys are SORTED so key ORDER never enters the comparison (the generated structs are alpha-
    // ordered; the corpus rows are DB-column-ordered — canon removes the difference), the SAME way the
    // go/py/php canon do.

    fn canon(v: &J) -> String {
        match v {
            J::Null => "null".to_string(),
            J::Bool(b) => {
                if *b {
                    "true".to_string()
                } else {
                    "false".to_string()
                }
            }
            J::String(s) => format!("{s:?}"),
            J::Number(n) => canon_number(n),
            J::Array(a) => {
                let parts: Vec<String> = a.iter().map(canon).collect();
                format!("[{}]", parts.join(","))
            }
            J::Object(m) => {
                // The bigint tag folds to its integer (the ONLY single-key object that is not a real record).
                if m.len() == 1 {
                    if let Some(J::String(s)) = m.get("$bigint") {
                        return s.clone();
                    }
                }
                let mut keys: Vec<&String> = m.keys().collect();
                keys.sort();
                let parts: Vec<String> = keys
                    .into_iter()
                    .map(|k| format!("{k:?}:{}", canon(&m[k])))
                    .collect();
                format!("{{{}}}", parts.join(","))
            }
        }
    }

    /// Fold a JSON number to canon text: an integer prints plain; an INTEGRAL float prints as the
    /// integer it denotes; a fractional float prints its shortest round-trip form.
    fn canon_number(n: &Number) -> String {
        if let Some(i) = n.as_i64() {
            return i.to_string();
        }
        if let Some(u) = n.as_u64() {
            return u.to_string();
        }
        if let Some(f) = n.as_f64() {
            if f.is_finite() && f == f.trunc() {
                return (f as i64).to_string();
            }
            return format!("{f}");
        }
        n.to_string()
    }

    fn num_f64(f: f64) -> J {
        Number::from_f64(f).map(J::Number).unwrap_or(J::Null)
    }

    // ── result lowering: a bc-generated typed struct → the plain JSON tree canon compares ─────────────
    //
    // Rust has no reflection, so — unlike the go leg's `reflectToAny` — the harness lowers each generated
    // outType with an explicit `ToCompare` impl. A struct's field name IS its wire key (bc lowercases the
    // wire key's first letter to make the field exported; here the field name already matches), so the
    // macro maps `self.<field>` under `"<field>"`; canon sorts the keys, so field ORDER is irrelevant.
    // This is HARNESS glue (the rust twin of go's reflect lowering), not business logic — no SQL, no
    // dialect branch, no result reshaping.

    trait ToCompare {
        fn to_compare(&self) -> J;
    }

    impl ToCompare for f64 {
        fn to_compare(&self) -> J {
            num_f64(*self)
        }
    }
    impl ToCompare for i64 {
        fn to_compare(&self) -> J {
            J::Number(Number::from(*self))
        }
    }
    impl ToCompare for String {
        fn to_compare(&self) -> J {
            J::String(self.clone())
        }
    }
    impl<T: ToCompare> ToCompare for Option<T> {
        fn to_compare(&self) -> J {
            match self {
                Some(v) => v.to_compare(),
                None => J::Null,
            }
        }
    }
    impl<T: ToCompare> ToCompare for Vec<T> {
        fn to_compare(&self) -> J {
            J::Array(self.iter().map(ToCompare::to_compare).collect())
        }
    }

    macro_rules! impl_to_compare {
        ($($m:ident)::+ { $($f:ident),+ $(,)? }) => {
            impl ToCompare for $($m)::+ {
                fn to_compare(&self) -> J {
                    let mut o = Map::new();
                    $( o.insert(stringify!($f).to_string(), self.$f.to_compare()); )+
                    J::Object(o)
                }
            }
        };
    }

    // The outType of every entry `callEntry` dispatches — for BOTH dialect modules (same declaration,
    // so the same fields). Only the endpoints the live-DB corpus actually carries are here (the
    // config-gated capped/uncapped/top relation reads are excluded by gen-livedb.ts, so their structs
    // are not lowered).
    impl_to_compare!(pg::PostsRow {
        author_id,
        created_at,
        id,
        status,
        title
    });
    impl_to_compare!(my::PostsRow {
        author_id,
        created_at,
        id,
        status,
        title
    });
    impl_to_compare!(pg::PostsTopRow {
        author_id,
        created_at,
        id,
        status,
        title
    });
    impl_to_compare!(my::PostsTopRow {
        author_id,
        created_at,
        id,
        status,
        title
    });
    impl_to_compare!(pg::PageRow { id, title });
    impl_to_compare!(my::PageRow { id, title });
    impl_to_compare!(pg::PostsByIdsRow { id, title });
    impl_to_compare!(my::PostsByIdsRow { id, title });
    impl_to_compare!(pg::FeedRow {
        author_id,
        id,
        status,
        title
    });
    impl_to_compare!(my::FeedRow {
        author_id,
        id,
        status,
        title
    });
    impl_to_compare!(pg::UsersWithPostsRow { id, name, posts });
    impl_to_compare!(my::UsersWithPostsRow { id, name, posts });
    impl_to_compare!(pg::UsersWithPostsRow_posts {
        author_id,
        created_at,
        id,
        status,
        tags,
        title
    });
    impl_to_compare!(my::UsersWithPostsRow_posts {
        author_id,
        created_at,
        id,
        status,
        tags,
        title
    });
    impl_to_compare!(pg::UsersWithPostsRow_posts_tags { id, label, post_id });
    impl_to_compare!(my::UsersWithPostsRow_posts_tags { id, label, post_id });
    impl_to_compare!(pg::PostsWithAuthorRow {
        author,
        author_id,
        created_at,
        id,
        status,
        title
    });
    impl_to_compare!(my::PostsWithAuthorRow {
        author,
        author_id,
        created_at,
        id,
        status,
        title
    });
    impl_to_compare!(pg::PostsWithAuthorRow_author {
        id,
        name,
        post_count
    });
    impl_to_compare!(my::PostsWithAuthorRow_author {
        id,
        name,
        post_count
    });
    impl_to_compare!(pg::WriteSummary {
        changes,
        lastInsertRowid
    });
    impl_to_compare!(my::WriteSummary {
        changes,
        lastInsertRowid
    });
    impl_to_compare!(pg::CreatePostReturningRow { id, title });
    impl_to_compare!(my::CreatePostReturningRow { id, title });
    impl_to_compare!(pg::RenamePostReturningRow { id, title });
    impl_to_compare!(my::RenamePostReturningRow { id, title });
    impl_to_compare!(pg::RemovePostReturningRow { id, title });
    impl_to_compare!(my::RemovePostReturningRow { id, title });
    impl_to_compare!(pg::RestatusPostsReturningRow { id, status });
    impl_to_compare!(my::RestatusPostsReturningRow { id, status });
    impl_to_compare!(pg::RemovePostsByAuthorReturningRow { id, title });
    impl_to_compare!(my::RemovePostsByAuthorReturningRow { id, title });
    impl_to_compare!(pg::TypedRowsRow {
        flag,
        id,
        label,
        ts
    });
    impl_to_compare!(my::TypedRowsRow {
        flag,
        id,
        label,
        ts
    });
    impl_to_compare!(pg::CreateTagsReturningRow { id, label });
    impl_to_compare!(my::CreateTagsReturningRow { id, label });
    impl_to_compare!(pg::RelabelTagsReturningRow { id, label });
    impl_to_compare!(my::RelabelTagsReturningRow { id, label });
    impl_to_compare!(pg::RemoveTagsReturningRow { id, label });
    impl_to_compare!(my::RemoveTagsReturningRow { id, label });

    // ── input decode (corpus JSON → the entry's positional native args) ───────────────────────────────

    fn in_i64(o: &J, k: &str) -> i64 {
        o.get(k)
            .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
            .unwrap_or(0)
    }
    fn in_str(o: &J, k: &str) -> String {
        o.get(k).and_then(J::as_str).unwrap_or("").to_string()
    }
    /// An optional predicate input (Feed's `status` / `since`): absent or JSON null ⇒ None (the SKIP-drop
    /// case) — the same nil the go `optStr` yields.
    fn in_opt_str(o: &J, k: &str) -> Option<String> {
        match o.get(k) {
            None | Some(J::Null) => None,
            Some(v) => v.as_str().map(str::to_string),
        }
    }
    fn in_i64s(o: &J, k: &str) -> Vec<i64> {
        o.get(k)
            .and_then(J::as_array)
            .map(|a| {
                a.iter()
                    .map(|e| {
                        e.as_i64()
                            .or_else(|| e.as_f64().map(|f| f as i64))
                            .unwrap_or(0)
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
    fn in_strs(o: &J, k: &str) -> Vec<String> {
        o.get(k)
            .and_then(J::as_array)
            .map(|a| {
                a.iter()
                    .map(|e| e.as_str().unwrap_or("").to_string())
                    .collect()
            })
            .unwrap_or_default()
    }
    fn in_records(o: &J) -> Vec<J> {
        o.get("rows")
            .and_then(J::as_array)
            .cloned()
            .unwrap_or_default()
    }

    // ── the sanctioned conformance switch (CLAUDE.md §3.1): one signature-direct call per endpoint ─────
    //
    // The batch endpoints bind a per-dialect INPUT shape (PG columnar arrays vs MySQL/SQLite one record
    // array — the SAME split the generated signatures declare), so those arms branch on dialect. Every
    // other arm is the same signature-direct call for both dialects.

    fn call_entry(dialect: &str, entry: &str, input: &J) -> Result<J, BehaviorError> {
        let pg = dialect == "postgres";
        match entry {
            "posts" => {
                let a = in_i64(input, "authorId");
                if pg {
                    pg::posts(a).map(|r| r.to_compare())
                } else {
                    my::posts(a).map(|r| r.to_compare())
                }
            }
            "postsTop" => {
                if pg {
                    pg::postsTop().map(|r| r.to_compare())
                } else {
                    my::postsTop().map(|r| r.to_compare())
                }
            }
            "page" => {
                let (l, o) = (in_i64(input, "limit"), in_i64(input, "offset"));
                if pg {
                    pg::page(l, o).map(|r| r.to_compare())
                } else {
                    my::page(l, o).map(|r| r.to_compare())
                }
            }
            "postsByIds" => {
                let ids = in_i64s(input, "ids");
                if pg {
                    pg::postsByIds(ids).map(|r| r.to_compare())
                } else {
                    my::postsByIds(ids).map(|r| r.to_compare())
                }
            }
            "feed" => {
                let (a, s, si) = (
                    in_i64(input, "authorId"),
                    in_opt_str(input, "status"),
                    in_opt_str(input, "since"),
                );
                if pg {
                    pg::feed(a, s, si).map(|r| r.to_compare())
                } else {
                    my::feed(a, s, si).map(|r| r.to_compare())
                }
            }
            "usersWithPosts" => {
                if pg {
                    pg::usersWithPosts().map(|r| r.to_compare())
                } else {
                    my::usersWithPosts().map(|r| r.to_compare())
                }
            }
            "postsWithAuthor" => {
                if pg {
                    pg::postsWithAuthor().map(|r| r.to_compare())
                } else {
                    my::postsWithAuthor().map(|r| r.to_compare())
                }
            }
            "createPost" => {
                let (id, a, t, s, c) = (
                    in_i64(input, "id"),
                    in_i64(input, "authorId"),
                    in_str(input, "title"),
                    in_str(input, "status"),
                    in_str(input, "createdAt"),
                );
                if pg {
                    pg::createPost(id, a, t, s, c).map(|r| r.to_compare())
                } else {
                    my::createPost(id, a, t, s, c).map(|r| r.to_compare())
                }
            }
            "renamePost" => {
                let (t, id) = (in_str(input, "title"), in_i64(input, "id"));
                if pg {
                    pg::renamePost(t, id).map(|r| r.to_compare())
                } else {
                    my::renamePost(t, id).map(|r| r.to_compare())
                }
            }
            "removePost" => {
                let id = in_i64(input, "id");
                if pg {
                    pg::removePost(id).map(|r| r.to_compare())
                } else {
                    my::removePost(id).map(|r| r.to_compare())
                }
            }
            "createPostReturning" => {
                let (id, a, t, s, c) = (
                    in_i64(input, "id"),
                    in_i64(input, "authorId"),
                    in_str(input, "title"),
                    in_str(input, "status"),
                    in_str(input, "createdAt"),
                );
                if pg {
                    pg::createPostReturning(id, a, t, s, c).map(|r| r.to_compare())
                } else {
                    my::createPostReturning(id, a, t, s, c).map(|r| r.to_compare())
                }
            }
            "renamePostReturning" => {
                let (t, id) = (in_str(input, "title"), in_i64(input, "id"));
                if pg {
                    pg::renamePostReturning(t, id).map(|r| r.to_compare())
                } else {
                    my::renamePostReturning(t, id).map(|r| r.to_compare())
                }
            }
            "removePostReturning" => {
                let id = in_i64(input, "id");
                if pg {
                    pg::removePostReturning(id).map(|r| r.to_compare())
                } else {
                    my::removePostReturning(id).map(|r| r.to_compare())
                }
            }
            "restatusPostsReturning" => {
                let (s, a) = (in_str(input, "status"), in_i64(input, "authorId"));
                if pg {
                    pg::restatusPostsReturning(s, a).map(|r| r.to_compare())
                } else {
                    my::restatusPostsReturning(s, a).map(|r| r.to_compare())
                }
            }
            "removePostsByAuthorReturning" => {
                let a = in_i64(input, "authorId");
                if pg {
                    pg::removePostsByAuthorReturning(a).map(|r| r.to_compare())
                } else {
                    my::removePostsByAuthorReturning(a).map(|r| r.to_compare())
                }
            }
            "typedRows" => {
                if pg {
                    pg::typedRows().map(|r| r.to_compare())
                } else {
                    my::typedRows().map(|r| r.to_compare())
                }
            }
            "removeTags" => {
                let ids = in_i64s(input, "ids");
                if pg {
                    pg::removeTags(ids).map(|r| r.to_compare())
                } else {
                    my::removeTags(ids).map(|r| r.to_compare())
                }
            }
            "removeTagsReturning" => {
                let ids = in_i64s(input, "ids");
                if pg {
                    pg::removeTagsReturning(ids).map(|r| r.to_compare())
                } else {
                    my::removeTagsReturning(ids).map(|r| r.to_compare())
                }
            }
            "createTags" => {
                if pg {
                    pg::createTags(
                        in_i64s(input, "rows_id"),
                        in_i64s(input, "rows_post_id"),
                        in_strs(input, "rows_label"),
                    )
                    .map(|r| r.to_compare())
                } else {
                    let rows = in_records(input)
                        .iter()
                        .map(|r| my::CreateTagsRecord {
                            id: in_i64(r, "id"),
                            post_id: in_i64(r, "post_id"),
                            label: in_str(r, "label"),
                        })
                        .collect();
                    my::createTags(rows).map(|r| r.to_compare())
                }
            }
            "createTagsReturning" => {
                if pg {
                    pg::createTagsReturning(
                        in_i64s(input, "rows_id"),
                        in_i64s(input, "rows_post_id"),
                        in_strs(input, "rows_label"),
                    )
                    .map(|r| r.to_compare())
                } else {
                    let rows = in_records(input)
                        .iter()
                        .map(|r| my::CreateTagsReturningRecord {
                            id: in_i64(r, "id"),
                            post_id: in_i64(r, "post_id"),
                            label: in_str(r, "label"),
                        })
                        .collect();
                    my::createTagsReturning(rows).map(|r| r.to_compare())
                }
            }
            "relabelTagsReturning" => {
                if pg {
                    pg::relabelTagsReturning(
                        in_i64s(input, "rows_id"),
                        in_strs(input, "rows_label"),
                    )
                    .map(|r| r.to_compare())
                } else {
                    let rows = in_records(input)
                        .iter()
                        .map(|r| my::RelabelTagsReturningRecord {
                            id: in_i64(r, "id"),
                            label: in_str(r, "label"),
                        })
                        .collect();
                    my::relabelTagsReturning(rows).map(|r| r.to_compare())
                }
            }
            other => Err(BehaviorError::new(
                "UNKNOWN_ENTRY",
                format!("unknown entry {other:?}"),
            )),
        }
    }

    // ── statement TAP: the SQL the leaf transport handed the driver, at the driver contact point ───────
    //
    // A thin [`Driver`] wrapper that records `(sql, params)` at `prepare(sql).all()/run()` — the SAME
    // driver contact the python `_TapDriver` taps. It adds NO behavior: the inner driver executes
    // exactly as unwrapped. What it records is the exact driver-bound form the leaf produced: the
    // dynamic (SKIP) WHERE already assembled and `?`→`$N` already rendered by `execute_sql` before it
    // reaches the driver. Schema reseed + the DB-state query run OFF this tap (directly on the inner
    // driver), so a vector's log holds only its own ops.

    type Log = RefCell<Vec<(String, Vec<Value>)>>;

    struct TapDriver<'a> {
        inner: &'a dyn Driver,
        log: &'a Log,
    }

    struct TapPrepared<'a> {
        inner: Box<dyn PreparedStatement + 'a>,
        sql: String,
        log: &'a Log,
    }

    impl PreparedStatement for TapPrepared<'_> {
        fn all(&mut self, params: &[Value]) -> Result<Vec<WireValue>, SqlFailure> {
            self.log
                .borrow_mut()
                .push((self.sql.clone(), params.to_vec()));
            self.inner.all(params)
        }
        fn run(&mut self, params: &[Value]) -> Result<RunInfo, SqlFailure> {
            self.log
                .borrow_mut()
                .push((self.sql.clone(), params.to_vec()));
            self.inner.run(params)
        }
    }

    impl Driver for TapDriver<'_> {
        fn dialect(&self) -> &'static str {
            self.inner.dialect()
        }
        fn prepare(&self, sql: &str) -> Box<dyn PreparedStatement + '_> {
            Box::new(TapPrepared {
                inner: self.inner.prepare(sql),
                sql: sql.to_string(),
                log: self.log,
            })
        }
        // The corpus endpoints never open a transaction; delegate the tx/session seam to the inner driver
        // for contract completeness (never exercised by a live-DB vector).
        fn begin_tx(&self) -> Result<Box<dyn TxConnection + '_>, SqlFailure> {
            self.inner.begin_tx()
        }
        fn acquire_tx(&self) -> Result<Box<dyn TxConnection + '_>, SqlFailure> {
            self.inner.acquire_tx()
        }
        fn session_connection(
            &self,
            setup: &[String],
            reset: &[String],
        ) -> Result<Box<dyn SessionConnection + '_>, SqlFailure> {
            self.inner.session_connection(setup, reset)
        }
    }

    // ── param + wire lowering to the plain JSON tree canon compares ───────────────────────────────────

    /// Lower ONE driver-bound param (a bc [`Value`]) to the plain tree. An IN-list / batch array rides
    /// as a [`Value::Arr`] here — the runtime binds it to the driver per dialect INTERNALLY (PG native
    /// array, MySQL `json_each`/`JSON_TABLE` JSON text), which the expected side reflects as a JSON
    /// array (PG) or a JSON-document string (MySQL); [`normalize_json_param`] reconciles the two by
    /// parsing the expected string, so the runner needs NO dialect branch and NO array re-encode.
    fn param_to_j(v: &Value) -> J {
        match v {
            Value::Null => J::Null,
            Value::Bool(b) => J::Bool(*b),
            Value::Int(i) => J::Number(Number::from(*i)),
            Value::Float(f) => num_f64(*f),
            Value::Str(s) => J::String(s.clone()),
            Value::Arr(a) => J::Array(a.iter().map(param_to_j).collect()),
            Value::Obj(o) => J::Object(
                o.iter()
                    .map(|(k, val)| (k.clone(), param_to_j(val)))
                    .collect(),
            ),
        }
    }

    /// Lower ONE read cell ([`WireValue`]) to the plain tree — used for the post-write DB-state assertion,
    /// which reads through the driver directly.
    fn wire_to_j(w: &WireValue) -> J {
        match w {
            WireValue::Null => J::Null,
            WireValue::Bool(b) => J::Bool(*b),
            WireValue::Int(i) => J::Number(Number::from(*i)),
            WireValue::Float(f) => num_f64(*f),
            WireValue::Str(s) => J::String(s.to_string()),
            WireValue::Row(r) => J::Object(
                r.entries
                    .iter()
                    .map(|(k, v)| (k.to_string(), wire_to_j(v)))
                    .collect(),
            ),
            WireValue::List(l) => J::Array(l.items.iter().map(wire_to_j).collect()),
        }
    }

    /// Parse a param that is a JSON-DOCUMENT string (the `?`-bound json_each / JSON_TABLE payload MySQL
    /// binds an IN-list / batch-record array as ONE JSON text) into its structural value, so canon
    /// compares it by CONTENT with keys sorted — exactly as canon already compares every result / DB-
    /// state object. It runs on BOTH the observed and the expected param (so it never changes WHICH
    /// statements match; it only stops a param's JSON key ORDER from mattering). This is the go leg's
    /// `normalizeJSONParam` twin: the bc typed-native emitter serializes a record's wire keys
    /// ALPHABETICALLY (id,label,post_id) whereas the TS/py/php reference the corpus was captured from
    /// keeps DECLARATION order (id,post_id,label) — the SAME logical param (JSON_TABLE extracts by
    /// `$.name`, never by position). A wrong value, a missing/extra key, or a non-JSON param still fails.
    fn normalize_json_param(p: J) -> J {
        if let J::String(s) = &p {
            let t = s.trim_start();
            if t.starts_with('[') || t.starts_with('{') {
                if let Ok(parsed) = serde_json::from_str::<J>(s) {
                    return parsed;
                }
            }
        }
        p
    }

    /// One `{sql, params}` statement, with each param JSON-normalized (both observed + expected pass
    /// through here, so the normalization is symmetric).
    fn stmt_j(sql: &str, params: Vec<J>) -> J {
        let params: Vec<J> = params.into_iter().map(normalize_json_param).collect();
        let mut o = Map::new();
        o.insert("sql".to_string(), J::String(sql.to_string()));
        o.insert("params".to_string(), J::Array(params));
        J::Object(o)
    }

    // ── one vector ────────────────────────────────────────────────────────────────────────────────────

    fn run_vector(driver: &dyn Driver, tap: &TapDriver, log: &Log, v: &J) -> (bool, String) {
        log.borrow_mut().clear();
        let dialect = v.get("dialect").and_then(J::as_str).unwrap_or("");
        let entry = v.get("entry").and_then(J::as_str).unwrap_or("");
        let empty = J::Object(Map::new());
        let input = v.get("input").unwrap_or(&empty);

        let result = with_ambient_driver(tap, || call_entry(dialect, entry, input));

        // Snapshot the vector's statements BEFORE the DB-state queries (which run OFF the tap anyway).
        let observed: Vec<(String, Vec<Value>)> = log.borrow().clone();

        let result = match result {
            Ok(r) => r,
            Err(e) => return (false, format!("threw: {} ({})", e.message, e.code)),
        };

        let mut problems: Vec<String> = Vec::new();

        // Statements.
        let got_stmts = J::Array(
            observed
                .iter()
                .map(|(sql, params)| stmt_j(sql, params.iter().map(param_to_j).collect()))
                .collect(),
        );
        let want_stmts = J::Array(
            v.get("expectedStatements")
                .and_then(J::as_array)
                .map(|a| {
                    a.iter()
                        .map(|s| {
                            let sql = s.get("sql").and_then(J::as_str).unwrap_or("");
                            let params = s
                                .get("params")
                                .and_then(J::as_array)
                                .cloned()
                                .unwrap_or_default();
                            stmt_j(sql, params)
                        })
                        .collect()
                })
                .unwrap_or_default(),
        );
        if canon(&got_stmts) != canon(&want_stmts) {
            problems.push(format!(
                "statements {} != {}",
                canon(&got_stmts),
                canon(&want_stmts)
            ));
        }

        // The FULL typed result (nested children + their values, #150).
        let empty_result = J::Null;
        let want_result = v.get("expectedResult").unwrap_or(&empty_result);
        if canon(&result) != canon(want_result) {
            problems.push(format!(
                "result {} != {}",
                canon(&result),
                canon(want_result)
            ));
        }

        // DB state after a write, read directly on the inner driver (OFF the tap).
        if let Some(states) = v.get("expectedDbState").and_then(J::as_array) {
            for s in states {
                let query = s.get("query").and_then(J::as_str).unwrap_or("");
                let want_rows = s.get("rows").cloned().unwrap_or(J::Null);
                match driver.prepare(query).all(&[]) {
                    Ok(rows) => {
                        let got_rows = J::Array(rows.iter().map(wire_to_j).collect());
                        if canon(&got_rows) != canon(&want_rows) {
                            problems.push(format!(
                                "db-state '{query}': {} != {}",
                                canon(&got_rows),
                                canon(&want_rows)
                            ));
                        }
                    }
                    Err(e) => {
                        problems.push(format!("db-state '{query}' query error: {}", e.message))
                    }
                }
            }
        }

        (problems.is_empty(), problems.join("; "))
    }

    // ── one leg ──────────────────────────────────────────────────────────────────────────────────────

    /// Reseed + run every vector of `dialect`. `reseed` reapplies the schema DDL on the concrete driver
    /// (a driver-inherent `exec_ddl`, off the tap) so each vector starts from the SAME seeded state the
    /// TS leg captured from.
    fn run_leg(
        dialect: &str,
        driver: &dyn Driver,
        reseed: &dyn Fn() -> Result<(), SqlFailure>,
        vectors: &[&J],
    ) -> (usize, usize) {
        eprintln!(
            "\nlivedb-{dialect} — {} vectors (real {dialect})",
            vectors.len()
        );
        let log: Log = RefCell::new(Vec::new());
        let tap = TapDriver {
            inner: driver,
            log: &log,
        };
        let (mut pass, mut fail) = (0usize, 0usize);
        for v in vectors {
            let name = v.get("name").and_then(J::as_str).unwrap_or("?");
            if let Err(e) = reseed() {
                fail += 1;
                eprintln!("  XX  {name}\n      seed: {}", e.message);
                continue;
            }
            let (ok, detail) = run_vector(driver, &tap, &log, v);
            if ok {
                pass += 1;
                eprintln!("  ok  {name}");
            } else {
                fail += 1;
                eprintln!("  XX  {name}\n      {detail}");
            }
        }
        (pass, fail)
    }

    // ── connection config (env-driven; matches the python leg's defaults + docker-compose.livedb.yml) ──

    fn env_or(k: &str, def: &str) -> String {
        std::env::var(k)
            .ok()
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| def.to_string())
    }

    fn pg_conn() -> String {
        format!(
            "host={} port={} user={} password={} dbname={} sslmode=disable",
            env_or("TEST_DB_HOST", "localhost"),
            env_or("TEST_DB_PORT", "5433"),
            env_or("TEST_DB_USER", "testuser"),
            env_or("TEST_DB_PASSWORD", "testpass"),
            env_or("TEST_DB_NAME", "testdb"),
        )
    }

    fn mysql_url() -> String {
        format!(
            "mysql://{}:{}@{}:{}/{}",
            env_or("TEST_MYSQL_USER", "testuser"),
            env_or("TEST_MYSQL_PASSWORD", "testpass"),
            env_or("TEST_MYSQL_HOST", "127.0.0.1"),
            env_or("TEST_MYSQL_PORT", "3307"),
            env_or("TEST_MYSQL_DB", "testdb"),
        )
    }

    fn print_summary(pg: (usize, usize), my: (usize, usize), version_mismatch: bool) {
        let summary = serde_json::json!({
            "lang": "rust-livedb",
            "suites": {
                "livedb-pg": {"pass": pg.0, "fail": pg.1},
                "livedb-mysql": {"pass": my.0, "fail": my.1},
            },
            "total_pass": pg.0 + my.0,
            "total_fail": pg.1 + my.1,
            "version_mismatch": version_mismatch,
        });
        println!("{summary}");
    }

    // ── main ─────────────────────────────────────────────────────────────────────────────────────────

    pub fn run() -> i32 {
        eprintln!("litedbmodel SCP LIVE-DB conformance — Rust runner (bc-generated modules, real PG + MySQL)");

        let corpus_path = std::env::var("LITEDBMODEL_LIVEDB_VECTORS").unwrap_or_default();
        if corpus_path.is_empty() {
            eprintln!("FATAL: LITEDBMODEL_LIVEDB_VECTORS is not set");
            return 2;
        }
        let data = match std::fs::read_to_string(&corpus_path) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("FATAL: cannot read corpus {corpus_path}: {e}");
                return 2;
            }
        };
        let corpus: J = match serde_json::from_str(&data) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("FATAL: cannot parse corpus: {e}");
                return 2;
            }
        };
        if corpus.get("corpusVersion").and_then(J::as_i64) != Some(SUPPORTED_CORPUS_VERSION) {
            eprintln!(
                "FAIL-CLOSED: corpusVersion {:?} != {SUPPORTED_CORPUS_VERSION}",
                corpus.get("corpusVersion")
            );
            print_summary((0, 0), (0, 0), true);
            return 2;
        }

        let schema: Vec<String> = corpus
            .get("schema")
            .and_then(J::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|s| s.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        let all_vectors: &[J] = corpus
            .get("vectors")
            .and_then(J::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let vectors_of = |d: &str| -> Vec<&J> {
            all_vectors
                .iter()
                .filter(|v| v.get("dialect").and_then(J::as_str) == Some(d))
                .collect()
        };

        let pg_driver = match PostgresDriver::connect(&pg_conn()) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("FATAL: Postgres unreachable — {}", e.message);
                return 3;
            }
        };
        let my_driver = match MysqlDriver::connect(&mysql_url()) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("FATAL: MySQL unreachable — {}", e.message);
                return 3;
            }
        };

        let pg_tally = run_leg(
            "postgres",
            &pg_driver,
            &|| pg_driver.exec_ddl(&schema),
            &vectors_of("postgres"),
        );
        let my_tally = run_leg(
            "mysql",
            &my_driver,
            &|| my_driver.exec_ddl(&schema),
            &vectors_of("mysql"),
        );

        let total_pass = pg_tally.0 + my_tally.0;
        let total_fail = pg_tally.1 + my_tally.1;
        eprintln!(
            "\n{total_pass} passed, {total_fail} failed / {} live-DB vectors",
            total_pass + total_fail
        );
        print_summary(pg_tally, my_tally, false);
        i32::from(total_fail > 0)
    }
}
