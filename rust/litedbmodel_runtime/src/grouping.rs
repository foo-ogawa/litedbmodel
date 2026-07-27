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
/// same stored value produce the same bits, which is what grouping needs (a NaN key never matches, and a
/// float key column is not a thing a relation is keyed on anyway). A Row/List is never a scalar key.
#[derive(Debug, PartialEq, Eq, Hash, Clone)]
pub enum KeyCell {
    Str(std::borrow::Cow<'static, str>),
    Int(i64),
    FloatBits(u64),
    Bool(bool),
    Null,
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
        WireValue::Float(f) => {
            if f.is_finite() && f.fract() == 0.0 {
                KeyCell::Int(*f as i64)
            } else {
                KeyCell::FloatBits(f.to_bits())
            }
        }
        WireValue::Row(_) | WireValue::List(_) => KeyCell::Null,
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
    let idx = rows.iter().find_map(|r| resolve_indices(r, key_cols));
    for row in rows {
        let cells = match idx.as_deref().and_then(|ix| key_cells(row, key_cols, ix)) {
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
    let idx = children.first().and_then(|c| resolve_indices(c, fk_cols));
    for child in children {
        let key = match idx.as_deref().and_then(|ix| row_key(&child, fk_cols, ix)) {
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
            None => true,
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
