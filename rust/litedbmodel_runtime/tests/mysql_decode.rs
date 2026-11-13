//! The MySQL row decode (`src/livedb.rs` `my_cell_to_wire`) reads every column as the value it holds:
//! a DECIMAL as its exact decimal text (never through an f64), and a BIGINT UNSIGNED as its own value —
//! one at or above 2^63 has no i64 to become, so it fails loudly instead of wrapping negative.
//!
//! Gated behind LITEDBMODEL_TX_ISOLATION=1 + docker up (MySQL:3307), like the other live rust suites.
#![cfg(feature = "livedb")]

mod common;

use litedbmodel_runtime::{Driver, MysqlDriver, SqlFailure, Value, WireValue};

const GATE: &str = "LITEDBMODEL_TX_ISOLATION";

/// #372 — BIGINT UNSIGNED reads as its value or fails, never negative; DECIMAL reads as its exact text.
#[test]
fn mysql_decode_decimal_and_unsigned_bigint() {
    common::require_live_db(GATE);
    let d = MysqlDriver::connect(&common::mysql_url()).expect("mysql connect");
    let t = format!("scp_mydecode_rs_{}", std::process::id());
    d.exec_ddl(&[
        format!("DROP TABLE IF EXISTS {t}"),
        format!("CREATE TABLE {t} (id INT PRIMARY KEY, amount DECIMAL(30, 10), big BIGINT UNSIGNED)"),
        format!("INSERT INTO {t} (id, amount, big) VALUES (1, 12345678901234567890.0123456789, 9223372036854775807)"),
        format!("INSERT INTO {t} (id, amount, big) VALUES (2, -0.5000000000, 18446744073709551615)"),
    ])
    .expect("mysql table");
    // The one column `col` of row `id`.
    let cell = |col: &str, id: i64| -> Result<WireValue, SqlFailure> {
        let rows = d
            .prepare(&format!("SELECT {col} FROM {t} WHERE id = ?"))
            .all(&[Value::Int(id)])?;
        let WireValue::Row(r) = &rows[0] else {
            panic!("not a row")
        };
        Ok(r.entries[0].1.clone())
    };

    // BIGINT UNSIGNED: i64::MAX is an int; 2^64 - 1 has no i64, so the read fails — it is not -1.
    match cell("big", 1).expect("BIGINT UNSIGNED i64::MAX") {
        WireValue::Int(n) => assert_eq!(n, i64::MAX, "BIGINT UNSIGNED within the int range"),
        _ => panic!("BIGINT UNSIGNED did not read as an int"),
    }
    match cell("big", 2) {
        Ok(WireValue::Int(n)) => {
            panic!("BIGINT UNSIGNED 18446744073709551615 read as {n}, want a decode error")
        }
        Ok(_) => {
            panic!("BIGINT UNSIGNED 18446744073709551615 read as a non-int, want a decode error")
        }
        Err(e) => assert!(
            format!("{e:?}").contains("18446744073709551615"),
            "the error names the value: {e:?}"
        ),
    }

    // DECIMAL: its exact decimal text, never an f64.
    for (id, want) in [(1, "12345678901234567890.0123456789"), (2, "-0.5000000000")] {
        match cell("amount", id).expect("DECIMAL read") {
            WireValue::Str(s) => assert_eq!(s, want, "DECIMAL text"),
            _ => panic!("DECIMAL did not read as its text"),
        }
    }

    d.exec_ddl(&[format!("DROP TABLE IF EXISTS {t}")])
        .expect("drop");
}
