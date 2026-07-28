//! litedbmodel v2 SCP — the SHARED relation-grouping CORE (#141), Rust port.
//!
//! The ONE implementation of relation key-identity + dedupe + parent grouping over the RUNTIME-FREE
//! wire rows ([`WireValue`] — the type the generated native module speaks), byte-behaviour-identical
//! to the TS SSoT `src/scp/grouping.ts`. It works DIRECTLY on `WireValue` so the `pluck`/`group` leaf
//! transports carry NO `WireValue`↔`Value` conversion in the hot path (the read path never boxes into
//! bc's `Value`): the only place a wire number becomes a typed scalar is the generated module's final
//! de-box of its OUTPUT columns.
//!
//! Nothing here touches SQL or a driver: it is pure in-memory grouping over already-fetched rows
//! (`WireValue::Row` records). Ordered TUPLE keys are supported (composite keys), matching TS.

use std::collections::HashMap;

use crate::wire::{WireList, WireValue};

/// The key identity for dedupe/grouping — the key CELLS themselves, not a rendering of them.
///
/// A raw-driver consumer groups on the native key (`HashMap<i64, …>` for a single column, a tuple key for
/// a composite one) and allocates nothing per row. This did the opposite: it rendered every key cell to a
/// `String`, collected those into a `Vec`, and joined them, so a relation level cost `keys + 2`
/// allocations per row on top of the read — which is why the relation ops sat at 2.7-4.4x a raw driver
/// while a flat read of the same rows sat at 1.0-1.6x. Now that the wire carries `Int`/`Float` natively
/// (bc 0.11.9), the cells can BE the key.
///
/// `Eq`/`Hash` are derived from the scalar variants. `Float` hashes on its bit pattern: two reads of the
/// same stored value produce the same bits, which is what grouping needs. (Two NaN keys DO match here —
/// identical bits — which is the reference's behaviour too, since `String(NaN)` is `"NaN"` for both.)
/// A Row/List is not a scalar key, but `key_identity` is public and must be total, so each keys as its
/// own distinct cell rather than sharing one with `Null`.
#[derive(Debug, PartialEq, Eq, Hash, Clone)]
pub enum KeyCell {
    Str(std::borrow::Cow<'static, str>),
    Int(i64),
    FloatBits(u64),
    Bool(bool),
    Null,
    Row,
    List,
}

/// The key a row contributes. A relation is keyed on ONE column (a FK) or TWO (a composite key), so
/// those arms carry their cells INLINE and building a key allocates NOTHING — the same shape a
/// raw-driver consumer uses (`HashMap<i64, …>` / `HashMap<(i64,i64), …>`). `Many` is the totality arm
/// for a wider key and is the only one that touches the heap.
///
/// This is the last per-row allocation in a relation level. It used to be a `Vec<KeyCell>` — one heap
/// allocation per child AND per parent, per level — which is why a 2-level relation cost ~820ns/row over
/// a raw driver while a flat read of the same rows cost ~230ns/row.
#[derive(Debug, PartialEq, Eq, Hash, Clone)]
pub enum KeyIdentity {
    One(KeyCell),
    Two(KeyCell, KeyCell),
    Many(Vec<KeyCell>),
}

/// Project one key cell. Null is dropped by the caller before it reaches a bucket.
fn key_cell(value: &WireValue) -> KeyCell {
    match value {
        WireValue::Null => KeyCell::Null,
        WireValue::Bool(b) => KeyCell::Bool(*b),
        // `1` and `"1"` are ONE key. The rendering this replaces collapsed them (both `String(v)` to
        // `"1"`), and a driver may hand a numeric column back as text, so the collapse is load-bearing.
        // Only an EXACT round-trip collapses, so `"01"` and `" 1"` stay distinct strings.
        WireValue::Str(s) => match s.parse::<i64>() {
            Ok(n) if n.to_string() == **s => KeyCell::Int(n),
            _ => KeyCell::Str(s.clone()),
        },
        WireValue::Int(i) => KeyCell::Int(*i),
        // A whole float and the same integer must land in the SAME bucket — a parent read as `1` and a
        // child FK read as `1.0` are the same key. Normalize to the integer, exactly as the rendering
        // form did (`"1.0"` → `"1"`), and keep the bits only for a genuinely fractional value.
        //
        // The RANGE test is what makes this safe, and a round-trip through `i64` is not a substitute:
        // `as` SATURATES, so every whole float above `i64::MAX` casts to `i64::MAX` and they would all
        // share one bucket. A round-trip does not catch it either — `i64::MAX as f64` rounds UP to 2^63,
        // so `2^63` would round-trip and collide with `i64::MAX`. Comparing against the bounds first is
        // exact: both constants below are representable in `f64`.
        WireValue::Float(f) => {
            const I64_MIN_F: f64 = -9_223_372_036_854_775_808.0; // i64::MIN, exact
            const I64_SUP_F: f64 = 9_223_372_036_854_775_808.0; // 2^63, the first f64 past i64::MAX
            if f.fract() == 0.0 && *f >= I64_MIN_F && *f < I64_SUP_F {
                KeyCell::Int(*f as i64)
            } else {
                KeyCell::FloatBits(f.to_bits())
            }
        }
        WireValue::Row(_) => KeyCell::Row,
        WireValue::List(_) => KeyCell::List,
    }
}

/// The key identity of a key-cell tuple.
pub fn key_identity(values: &[&WireValue]) -> KeyIdentity {
    match values {
        [a] => KeyIdentity::One(key_cell(a)),
        [a, b] => KeyIdentity::Two(key_cell(a), key_cell(b)),
        _ => KeyIdentity::Many(values.iter().map(|v| key_cell(v)).collect()),
    }
}

/// A row field by column name (a `WireValue::Row` is insertion-ordered pairs). `None` = the field is
/// ABSENT (the TS `undefined`), distinct from a present `WireValue::Null`.
fn field<'a>(row: &'a WireValue, col: &str) -> Option<&'a WireValue> {
    match row {
        WireValue::Row(r) => r.entries.iter().find(|(k, _)| k == col).map(|(_, v)| v),
        _ => None,
    }
}

/// Resolve each of `cols` to its POSITION in a sample `Row`. Every row of a SQL result set shares the
/// SAME column order, so this is resolved ONCE and reused across all rows — replacing the per-cell
/// linear scan with O(1) index access. `None` if `sample` is not a `Row`; an absent column resolves to
/// `usize::MAX` (its per-row lookup then reports absent, falling back to the name scan).
fn resolve_indices(sample: &WireValue, cols: &[String]) -> Option<Vec<usize>> {
    let entries = match sample {
        WireValue::Row(r) => &r.entries,
        _ => return None,
    };
    Some(
        cols.iter()
            .map(|c| {
                entries
                    .iter()
                    .position(|(k, _)| k == c)
                    .unwrap_or(usize::MAX)
            })
            .collect(),
    )
}

/// Resolve the key-column indices from the first `Row` in `rows` (all rows of a result set share the
/// SAME column order), or all-absent (`usize::MAX`) if none is a `Row`. Callers resolve ONCE and pass
/// the result to [`attach_to_parent`] so the per-parent path carries NO index scan — even when the
/// parent set is a large intermediate relation level (a nested chain groups the middle level twice).
pub fn resolve_key_indices(rows: &[WireValue], cols: &[String]) -> Vec<usize> {
    rows.iter()
        .find_map(|r| resolve_indices(r, cols))
        .unwrap_or_else(|| vec![usize::MAX; cols.len()])
}

/// The key cells of `row` via precomputed `idx` (O(1) index access; verifies the column name still
/// matches, else falls back to the linear `field`). `None` if any key column is ABSENT or `Null`
/// (the no-partial-keys drop) — the same predicate as `field` + `is_missing`.
/// One key column's cell via its precomputed index, falling back to a name scan if the row's shape
/// differs from the sample. `None` for an ABSENT or `Null` cell (the no-partial-keys drop).
fn key_cell_at<'a>(
    row: &'a WireValue,
    entries: &'a [(std::borrow::Cow<'static, str>, WireValue)],
    col: &str,
    i: usize,
) -> Option<&'a WireValue> {
    let cell = match entries.get(i) {
        Some((k, v)) if k == col => v,
        _ => field(row, col)?, // row shape differs from the sample — safe linear fallback
    };
    if matches!(cell, WireValue::Null) {
        return None;
    }
    Some(cell)
}

/// The key identity of `row` over `cols`, built WITHOUT a heap allocation for the 1- and 2-column keys
/// every relation actually uses. `None` if any key column is ABSENT or `Null`.
fn row_key(row: &WireValue, cols: &[String], idx: &[usize]) -> Option<KeyIdentity> {
    let entries = match row {
        WireValue::Row(r) => r.entries.as_slice(),
        _ => return None,
    };
    match (cols, idx) {
        ([c0], [i0]) => Some(KeyIdentity::One(key_cell(key_cell_at(
            row, entries, c0, *i0,
        )?))),
        ([c0, c1], [i0, i1]) => Some(KeyIdentity::Two(
            key_cell(key_cell_at(row, entries, c0, *i0)?),
            key_cell(key_cell_at(row, entries, c1, *i1)?),
        )),
        _ => {
            let mut out = Vec::with_capacity(cols.len());
            for (c, &i) in cols.iter().zip(idx) {
                out.push(key_cell(key_cell_at(row, entries, c, i)?));
            }
            Some(KeyIdentity::Many(out))
        }
    }
}

fn key_cells<'a>(row: &'a WireValue, cols: &[String], idx: &[usize]) -> Option<Vec<&'a WireValue>> {
    let entries = match row {
        WireValue::Row(r) => r.entries.as_slice(),
        _ => return None,
    };
    let mut out = Vec::with_capacity(cols.len());
    for (c, &i) in cols.iter().zip(idx) {
        out.push(key_cell_at(row, entries, c, i)?);
    }
    Some(out)
}

/// The deduped, non-null key TUPLES of `rows` over `key_cols` (insertion order preserved —
/// deterministic). A tuple is dropped if ANY of its key columns is absent/null (no partial keys);
/// deduped on the stringified tuple identity. Port of TS `dedupeKeyTuples`.
pub fn dedupe_key_tuples(rows: &[WireValue], key_cols: &[String]) -> Vec<Vec<WireValue>> {
    let mut seen: std::collections::HashSet<KeyIdentity> = std::collections::HashSet::new();
    let mut out: Vec<Vec<WireValue>> = Vec::new();
    let idx = resolve_key_indices(rows, key_cols);
    for row in rows {
        let cells = match key_cells(row, key_cols, &idx) {
            Some(c) => c,
            None => continue,
        };
        let ident = key_identity(&cells);
        if seen.insert(ident) {
            out.push(cells.into_iter().cloned().collect());
        }
    }
    out
}

/// Group `children` by their `fk_cols` tuple identity (a null/absent key drops the child). Child list
/// order within a bucket is the input order (push order). Port of TS `groupByKey`.
///
/// The buckets OWN the children: each child is MOVED into its bucket, and [`attach_to_parent`] then moves
/// the bucket into the parent it belongs to. Nothing is deep-copied. The previous form borrowed the
/// children and cloned each matched one into its parent — a whole `WireRow` per child, keys included,
/// which at 10,000 grandchildren was the dominant cost of a relation op (a raw-driver consumer moves its
/// grouped slice into the parent, and TS shares the array by reference; neither copies a row).
pub fn group_by_key(
    children: Vec<WireValue>,
    fk_cols: &[String],
) -> HashMap<KeyIdentity, Vec<WireValue>> {
    let mut by_key: HashMap<KeyIdentity, Vec<WireValue>> = HashMap::new();
    // `resolve_key_indices`, NOT `children.first()`: the first element deciding for all of them means a
    // single non-`Row` head resolves to nothing and then EVERY child is dropped — total, silent data
    // loss. Its two siblings in this file already resolved off the first row that IS a `Row`; this is the
    // one lookup, in one place.
    let idx = resolve_key_indices(&children, fk_cols);
    for child in children {
        let key = match row_key(&child, fk_cols, &idx) {
            Some(k) => k,
            None => continue,
        };
        by_key.entry(key).or_default().push(child);
    }
    by_key
}

/// How many parents claim each key. A key claimed once (the normal case — parents are a key-set window)
/// lets [`attach_to_parent`] MOVE its bucket; a key claimed by several parents clones for all but the
/// last, which is what keeps the duplicate-parent semantics identical to TS (where every such parent
/// gets the same array, shared by reference).
pub fn count_parent_keys(
    parents: &[WireValue],
    pk_cols: &[String],
    pk_idx: &[usize],
) -> HashMap<KeyIdentity, usize> {
    let mut counts: HashMap<KeyIdentity, usize> = HashMap::new();
    for parent in parents {
        if let Some(k) = row_key(parent, pk_cols, pk_idx) {
            *counts.entry(k).or_insert(0) += 1;
        }
    }
    counts
}

/// Distribute grouped children onto ONE parent per cardinality (port of TS `attachToParent`):
/// `single == false` (hasMany) → the child list as `WireValue::List` (`[]` when none); `single == true`
/// (belongsTo/hasOne) → the single child (or `WireValue::Null`). Keyed by the parent's `pk_cols` tuple
/// identity; a null/absent parent key matches nothing (`[]`/`null`).
///
/// The bucket is MOVED into the parent when this is the last parent claiming that key — the normal case,
/// so a relation op copies no rows. `remaining` is decremented per claim, and an earlier claimant of a
/// key several parents share takes a clone, so every such parent still gets the children (TS hands them
/// all the same array by reference).
pub fn attach_to_parent(
    parent: &WireValue,
    pk_cols: &[String],
    pk_idx: &[usize],
    by_key: &mut HashMap<KeyIdentity, Vec<WireValue>>,
    remaining: &mut HashMap<KeyIdentity, usize>,
    single: bool,
) -> WireValue {
    // `pk_idx` is resolved ONCE by the caller (all parents share column order) — no per-parent scan.
    let ident = row_key(parent, pk_cols, pk_idx);
    let rows: Option<Vec<WireValue>> = ident.and_then(|id| {
        let last = match remaining.get_mut(&id) {
            Some(n) => {
                *n -= 1;
                *n == 0
            }
            // Unreachable under the contract: `remaining` is counted over the SAME parent slice this is
            // iterated over, so every parent's key is in it. It is `false`, not `true`, because the two
            // failure modes are not symmetric — `true` would make this parent REMOVE the bucket and every
            // later parent sharing the key silently receive nothing, i.e. wrong data. `false` clones, so a
            // miscounted key costs a copy and still returns the right children.
            None => {
                debug_assert!(
                    false,
                    "attach_to_parent: parent key missing from the count map"
                );
                false
            }
        };
        if last {
            by_key.remove(&id)
        } else {
            by_key.get(&id).cloned()
        }
    });
    if !single {
        return WireValue::List(WireList {
            items: rows.unwrap_or_default(),
        });
    }
    match rows.and_then(|mut r| {
        if r.is_empty() {
            None
        } else {
            Some(r.swap_remove(0))
        }
    }) {
        Some(child) => child,
        None => WireValue::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::WireRow;

    fn num(n: i64) -> WireValue {
        WireValue::Int(n)
    }
    fn row(pairs: &[(&str, WireValue)]) -> WireValue {
        WireValue::Row(WireRow {
            entries: pairs
                .iter()
                .map(|(k, v)| (k.to_string().into(), v.clone()))
                .collect(),
        })
    }
    fn cols(cs: &[&str]) -> Vec<String> {
        cs.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn key_identity_matches_js_string() {
        // A whole float and the same integer are the SAME key (a parent read as `1` and a child FK read
        // as `1.0` must land in one bucket); bool / string ride verbatim. A 1- or 2-column key is inline.
        assert_eq!(
            key_identity(&[&WireValue::Float(1.0)]),
            KeyIdentity::One(KeyCell::Int(1))
        );
        assert_eq!(
            key_identity(&[&WireValue::Int(2)]),
            KeyIdentity::One(KeyCell::Int(2))
        );
        assert_eq!(
            key_identity(&[&WireValue::Str("x".into())]),
            KeyIdentity::One(KeyCell::Str("x".into()))
        );
        assert_eq!(
            key_identity(&[&WireValue::Bool(true)]),
            KeyIdentity::One(KeyCell::Bool(true))
        );
        assert_eq!(
            key_identity(&[&WireValue::Float(1.5)]),
            KeyIdentity::One(KeyCell::FloatBits(1.5f64.to_bits()))
        );
        assert_eq!(
            key_identity(&[&WireValue::Int(1), &WireValue::Str("a".into())]),
            KeyIdentity::Two(KeyCell::Int(1), KeyCell::Str("a".into()))
        );
    }

    #[test]
    fn dedupe_drops_null_and_dedupes_preserving_order() {
        let rows = vec![
            row(&[("id", num(2))]),
            row(&[("id", num(1))]),
            row(&[("id", num(2))]),          // dup
            row(&[("id", WireValue::Null)]), // dropped (null)
            row(&[("other", num(9))]),       // dropped (absent id)
        ];
        let keys = dedupe_key_tuples(&rows, &cols(&["id"]));
        let flat: Vec<String> = keys
            .iter()
            .map(|t| match &t[0] {
                WireValue::Int(i) => i.to_string(),
                _ => panic!(),
            })
            .collect();
        assert_eq!(flat, vec!["2", "1"]); // insertion order, deduped, nulls/absent dropped
    }

    #[test]
    fn group_and_attach_hasmany() {
        let children = vec![
            row(&[("id", num(10)), ("author_id", num(1))]),
            row(&[("id", num(11)), ("author_id", num(2))]),
            row(&[("id", num(12)), ("author_id", num(1))]),
        ];
        let mut by_key = group_by_key(children, &cols(&["author_id"]));
        let parent1 = row(&[("id", num(1))]);
        let pk = cols(&["id"]);
        let idx1 = resolve_key_indices(std::slice::from_ref(&parent1), &pk);
        let mut remaining = count_parent_keys(std::slice::from_ref(&parent1), &pk, &idx1);
        let nested = attach_to_parent(&parent1, &pk, &idx1, &mut by_key, &mut remaining, false);
        match nested {
            WireValue::List(l) => assert_eq!(l.items.len(), 2), // posts 10 and 12
            _ => panic!("expected a list"),
        }
        // a parent with no children → empty list
        let parent9 = row(&[("id", num(9))]);
        let idx9 = resolve_key_indices(std::slice::from_ref(&parent9), &pk);
        let mut remaining9 = count_parent_keys(std::slice::from_ref(&parent9), &pk, &idx9);
        match attach_to_parent(&parent9, &pk, &idx9, &mut by_key, &mut remaining9, false) {
            WireValue::List(l) => assert!(l.items.is_empty()),
            _ => panic!(),
        }
    }

    #[test]
    fn attach_belongs_to_single() {
        let children = vec![row(&[("id", num(5)), ("user_id", num(1))])];
        let mut by_key = group_by_key(children, &cols(&["user_id"]));
        let parent = row(&[("id", num(1))]);
        let pk = cols(&["id"]);
        let idx = resolve_key_indices(std::slice::from_ref(&parent), &pk);
        let mut remaining = count_parent_keys(std::slice::from_ref(&parent), &pk, &idx);
        match attach_to_parent(&parent, &pk, &idx, &mut by_key, &mut remaining, true) {
            WireValue::Row(_) => {}
            _ => panic!("expected the single child row"),
        }
        let parent9 = row(&[("id", num(9))]);
        let idx9 = resolve_key_indices(std::slice::from_ref(&parent9), &pk);
        let mut remaining9 = count_parent_keys(std::slice::from_ref(&parent9), &pk, &idx9);
        assert!(matches!(
            attach_to_parent(&parent9, &pk, &idx9, &mut by_key, &mut remaining9, true),
            WireValue::Null
        ));
    }

    // ── the four cases keying on native cells broke, none of which any existing test could see ──

    #[test]
    fn whole_float_past_i64_keys_by_bits_not_a_saturated_int() {
        // `*f as i64` SATURATES: every whole float above i64::MAX casts to i64::MAX, so without the range
        // test 1e30, 1e31 and i64::MAX all shared ONE bucket. A round-trip is not enough either —
        // `i64::MAX as f64` rounds up to 2^63, so 2^63 would round-trip onto i64::MAX.
        let big = key_identity(&[&WireValue::Float(1e30)]);
        let bigger = key_identity(&[&WireValue::Float(1e31)]);
        let max = key_identity(&[&WireValue::Int(i64::MAX)]);
        let two63 = key_identity(&[&WireValue::Float(9_223_372_036_854_775_808.0)]);
        assert_ne!(big, bigger);
        assert_ne!(big, max);
        assert_ne!(two63, max);
        // …while a whole float INSIDE the range still collapses onto the integer, which is the point.
        // -2^53 is chosen because it is exactly representable in f64 (2^53+1 is not — it rounds, and an
        // assertion about it would be testing the literal, not the key).
        assert_eq!(
            key_identity(&[&WireValue::Float(-9_007_199_254_740_992.0)]),
            KeyIdentity::One(KeyCell::Int(-9_007_199_254_740_992))
        );
    }

    #[test]
    fn row_list_and_null_are_three_distinct_keys() {
        // They shared `KeyCell::Null`, so a composite key holding a Row matched one holding a List or a
        // genuine NULL. `key_identity` is public and must be total.
        let r = key_identity(&[&row(&[("a", num(1))])]);
        let l = key_identity(&[&WireValue::List(crate::wire::WireList { items: vec![] })]);
        let n = key_identity(&[&WireValue::Null]);
        assert_ne!(r, l);
        assert_ne!(r, n);
        assert_ne!(l, n);
    }

    #[test]
    fn group_by_key_resolves_past_a_non_row_head() {
        // The index came from `children.first()`, so ONE non-Row head made every following child resolve
        // to nothing — total, silent data loss.
        let children = vec![
            WireValue::Int(0),
            row(&[("id", num(5)), ("user_id", num(1))]),
            row(&[("id", num(6)), ("user_id", num(1))]),
        ];
        let by_key = group_by_key(children, &cols(&["user_id"]));
        assert_eq!(by_key.len(), 1);
        assert_eq!(by_key[&KeyIdentity::One(KeyCell::Int(1))].len(), 2);
    }

    #[test]
    fn duplicate_parent_keys_each_receive_every_child() {
        // The pre-count is what lets a bucket be MOVED instead of cloned, and it must be taken over the
        // WHOLE parent slice — which is what the production call site does (leaves.rs). Every other test
        // in this file counts one parent at a time (`from_ref`), a convention under which the second
        // parent of a shared key silently gets ZERO children; so none of them can see this.
        let children = vec![
            row(&[("id", num(5)), ("user_id", num(1))]),
            row(&[("id", num(6)), ("user_id", num(1))]),
        ];
        let mut by_key = group_by_key(children, &cols(&["user_id"]));
        let parents = vec![row(&[("id", num(1))]), row(&[("id", num(1))])];
        let pk = cols(&["id"]);
        let idx = resolve_key_indices(&parents, &pk);
        let mut remaining = count_parent_keys(&parents, &pk, &idx);
        let counts: Vec<usize> = parents
            .iter()
            .map(
                |p| match attach_to_parent(p, &pk, &idx, &mut by_key, &mut remaining, false) {
                    WireValue::List(l) => l.items.len(),
                    _ => panic!("expected a list"),
                },
            )
            .collect();
        assert_eq!(
            counts,
            vec![2, 2],
            "both parents of a shared key get all children"
        );
    }

    #[test]
    fn composite_tuple_key() {
        let children = vec![
            row(&[("t", num(1)), ("p", num(9)), ("x", num(100))]),
            row(&[("t", num(1)), ("p", num(8)), ("x", num(200))]),
        ];
        let mut by_key = group_by_key(children, &cols(&["t", "p"]));
        // parent (t=1, p=9) matches only the first child (full tuple, not cartesian).
        let parent = row(&[("t", num(1)), ("p", num(9))]);
        let pk = cols(&["t", "p"]);
        let idx = resolve_key_indices(std::slice::from_ref(&parent), &pk);
        let mut remaining = count_parent_keys(std::slice::from_ref(&parent), &pk, &idx);
        match attach_to_parent(&parent, &pk, &idx, &mut by_key, &mut remaining, false) {
            WireValue::List(l) => assert_eq!(l.items.len(), 1),
            _ => panic!(),
        }
    }
}
