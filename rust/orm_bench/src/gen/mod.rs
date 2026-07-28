#![allow(non_snake_case, unused_imports, clippy::all)]
// The bc-GENERATED covered modules, ONE PER TARGET DB (#156 — `bc generate`, drift-gated by
// gen-native.sh). The SQL is baked per dialect, so a postgres run must drive the postgres module;
// there is no fallback. The cell selects one at COMPILE time through the cargo features below, so the
// call in `main.rs` resolves statically — no lookup at run time.
//
// sqlite is the DEFAULT (no feature), which keeps `cargo build` with no flags green.
pub mod mysql;
pub mod postgres;
pub mod sqlite;

#[cfg(all(feature = "target_mysql", not(feature = "target_postgres")))]
pub use mysql as active;
#[cfg(feature = "target_postgres")]
pub use postgres as active;
#[cfg(all(not(feature = "target_postgres"), not(feature = "target_mysql")))]
pub use sqlite as active;

/// The target this binary was built for — the cell reports it in the CSV `dialect` column and opens
/// the matching DB, so a mislabelled row is impossible.
pub const TARGET: &str = if cfg!(feature = "target_postgres") {
    "postgres"
} else if cfg!(feature = "target_mysql") {
    "mysql"
} else {
    "sqlite"
};
