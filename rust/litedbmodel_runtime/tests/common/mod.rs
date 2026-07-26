//! Shared preconditions for the live-DB integration tests (#168).
//!
//! Each integration test file is its own crate, so this is the one module both `livedb_middleware`
//! and `connection_routing` can share — the SSoT for "this suite needs a real database".

/// Assert the live-DB gate named `var` is open, panicking with the way to open it if it is not.
///
/// Both suites used to `return` early here instead, and `cargo test` counts an early return as PASS
/// — so `publish-crates.yml` gated a crate release on ten tests that had never executed. The gate is
/// declared in `livedb-gates.env` and loaded by CI; a leg that cannot reach the database FAILS, the
/// same rule the cross-language conformance runner states: NO mock, NO silent skip.
pub fn require_live_db(var: &str) {
    if std::env::var(var).as_deref() != Ok("1") {
        panic!(
            "this suite requires a real database: set {var}=1 (see livedb-gates.env) and bring the \
             docker services up (`npm run docker:livedb:up`). Skipping would report PASS for a test \
             that never ran."
        );
    }
}
