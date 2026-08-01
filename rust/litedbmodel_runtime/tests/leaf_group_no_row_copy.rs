//! `group_children` copies NOTHING per parent (#138) — measured, not asserted in prose.
//!
//! The relation leaf runs once per relation LEVEL over every parent of that level, so anything it
//! allocates per parent is multiplied by the whole result set (a 3-level chain over 100 parents /
//! 1,000 children / 10,000 grandchildren runs it twice, over 1,100 parents). Two spellings used to put
//! an allocation there and neither could be seen by a behavioural test, because both produce the
//! IDENTICAL graph:
//!
//!   - `r.entries.clone()` — in rust `Vec<(Cow, WireValue)>::clone()` is RECURSIVE, so "shallow-copy
//!     the parent, matching the TS `{...par}` spread" deep-copied every CELL of every parent. The
//!     other four runtimes really are shallow there (go copies a field slice of references, TS/python
//!     spread references, php `clone` is shallow), so rust alone paid it.
//!   - `into.to_string()` — a `String` per parent for a relation name that is the same on all of them.
//!
//! Both are invisible to a result assertion and to a latency check that has no baseline, so they are
//! pinned HERE by what they actually cost. The measurements are RATIOS, never absolute counts, so the
//! gate says what the design says and does not re-break on a toolchain that sizes a `HashMap`
//! differently:
//!
//!   - widen the parent ROWS (more columns, longer text), hold everything else → the leaf must
//!     allocate the SAME. A per-cell copy scales with width; a move does not.
//!   - lengthen the relation NAME, hold everything else → the leaf must allocate the same BYTES. A
//!     per-parent `to_string()` scales with the name; an interned key does not.
//!
//! Negative control (both re-measured on the way in): restoring `r.entries.clone()` fails the width
//! case, and restoring `into.to_string()` fails the name case.

use std::alloc::{GlobalAlloc, Layout, System};
use std::borrow::Cow;
use std::sync::atomic::{AtomicUsize, Ordering};

use litedbmodel_runtime::{group_children, WireList, WireRow, WireValue};

// ── the instrument ───────────────────────────────────────────────────────────────────────────────
//
// Counts every allocation and the bytes it asked for. A `realloc` counts as one allocation of the NEW
// size, which is what makes "append one field to an exact-capacity row" one allocation whose size
// tracks the row's width — the growth a per-cell copy would sit on top of.

static ALLOC_COUNT: AtomicUsize = AtomicUsize::new(0);
static ALLOC_BYTES: AtomicUsize = AtomicUsize::new(0);

struct Counting;

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOC_COUNT.fetch_add(1, Ordering::Relaxed);
        ALLOC_BYTES.fetch_add(layout.size(), Ordering::Relaxed);
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        ALLOC_COUNT.fetch_add(1, Ordering::Relaxed);
        ALLOC_BYTES.fetch_add(layout.size(), Ordering::Relaxed);
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        ALLOC_COUNT.fetch_add(1, Ordering::Relaxed);
        ALLOC_BYTES.fetch_add(new_size, Ordering::Relaxed);
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

// ── the workload ─────────────────────────────────────────────────────────────────────────────────

const PARENTS: i64 = 200;
const CHILDREN_PER_PARENT: i64 = 5;

/// One parent row: the key column plus `text_cols` text cells of `text_len` bytes each — the shape a
/// driver hands over (`Vec` sized to the column count exactly, every text cell OWNING its bytes).
fn parent_row(id: i64, text_cols: usize, text_len: usize) -> WireValue {
    let mut entries: Vec<(Cow<'static, str>, WireValue)> = Vec::with_capacity(text_cols + 1);
    entries.push((Cow::Borrowed("id"), WireValue::Int(id)));
    for name in COLUMN_NAMES.iter().take(text_cols) {
        entries.push((
            Cow::Borrowed(*name),
            WireValue::Str(Cow::Owned("x".repeat(text_len))),
        ));
    }
    WireValue::Row(WireRow { entries })
}

const COLUMN_NAMES: [&str; 12] = [
    "c00", "c01", "c02", "c03", "c04", "c05", "c06", "c07", "c08", "c09", "c10", "c11",
];

fn child_row(id: i64, parent_id: i64) -> WireValue {
    WireValue::Row(WireRow {
        entries: vec![
            (Cow::Borrowed("id"), WireValue::Int(id)),
            (Cow::Borrowed("parent_id"), WireValue::Int(parent_id)),
        ],
    })
}

fn strings(items: &[&str]) -> WireValue {
    WireValue::List(WireList {
        items: items
            .iter()
            .map(|s| WireValue::Str(Cow::Owned((*s).to_string())))
            .collect(),
    })
}

/// The `{children, fk, into, parents, pk, single}` payload the covered runner assembles for a hasMany
/// relation level.
fn payload(text_cols: usize, text_len: usize, into: &str) -> WireRow {
    let parents: Vec<WireValue> = (0..PARENTS)
        .map(|id| parent_row(id, text_cols, text_len))
        .collect();
    let children: Vec<WireValue> = (0..PARENTS)
        .flat_map(|pid| {
            (0..CHILDREN_PER_PARENT).map(move |c| child_row(pid * CHILDREN_PER_PARENT + c, pid))
        })
        .collect();
    WireRow {
        entries: vec![
            (
                Cow::Borrowed("children"),
                WireValue::List(WireList { items: children }),
            ),
            (Cow::Borrowed("fk"), strings(&["parent_id"])),
            (
                Cow::Borrowed("into"),
                WireValue::Str(Cow::Owned(into.to_string())),
            ),
            (
                Cow::Borrowed("parents"),
                WireValue::List(WireList { items: parents }),
            ),
            (Cow::Borrowed("pk"), strings(&["id"])),
            (Cow::Borrowed("single"), WireValue::Bool(false)),
        ],
    }
}

/// Allocations (count, bytes) charged to ONE `group_children` call. The payload is built BEFORE the
/// counters are read, so only the leaf is measured; a warm-up call first pays the one-time costs the
/// leaf's interner has for a name it has never seen.
fn cost(text_cols: usize, text_len: usize, into: &str) -> (usize, usize) {
    let warm = group_children(payload(text_cols, text_len, into)).expect("warm-up");
    drop(warm);

    let input = payload(text_cols, text_len, into);
    let count_before = ALLOC_COUNT.load(Ordering::Relaxed);
    let bytes_before = ALLOC_BYTES.load(Ordering::Relaxed);
    let out = group_children(input).expect("group_children");
    let count = ALLOC_COUNT.load(Ordering::Relaxed) - count_before;
    let bytes = ALLOC_BYTES.load(Ordering::Relaxed) - bytes_before;

    // The graph is still the graph — a leaf that allocated nothing because it produced nothing would
    // otherwise pass every assertion below.
    match &out {
        WireValue::List(l) => {
            assert_eq!(l.items.len(), PARENTS as usize, "one row out per parent");
            for p in &l.items {
                let entries = match p {
                    WireValue::Row(r) => &r.entries,
                    other => panic!("expected a row, got {:?}", wire_tag(other)),
                };
                let nested = entries
                    .iter()
                    .find(|(k, _)| k == into)
                    .unwrap_or_else(|| panic!("parent has no `{into}`"));
                match &nested.1 {
                    WireValue::List(children) => assert_eq!(
                        children.items.len(),
                        CHILDREN_PER_PARENT as usize,
                        "every parent keeps all its children"
                    ),
                    other => panic!("expected a child list, got {:?}", wire_tag(other)),
                }
            }
        }
        other => panic!("expected a list, got {:?}", wire_tag(other)),
    }
    drop(out);
    (count, bytes)
}

fn wire_tag(v: &WireValue) -> &'static str {
    match v {
        WireValue::Str(_) => "Str",
        WireValue::Int(_) => "Int",
        WireValue::Float(_) => "Float",
        WireValue::Bool(_) => "Bool",
        WireValue::Null => "Null",
        WireValue::Row(_) => "Row",
        WireValue::List(_) => "List",
    }
}

// ── the gates ────────────────────────────────────────────────────────────────────────────────────

#[test]
fn group_children_allocates_per_parent_not_per_cell() {
    // ONE test function, because the counters are process-global and `cargo test` runs test functions
    // on concurrent threads — a second test measuring in parallel would charge its allocations here.

    // ① WIDTH. Same parents, same children, same name — only the rows get wider and their text longer.
    // A per-cell copy allocates once per text cell (and copies its bytes); a move does neither.
    let (narrow_count, narrow_bytes) = cost(2, 8, "posts");
    let (wide_count, wide_bytes) = cost(11, 64, "posts");

    println!("width:  narrow(2x8) = {narrow_count} allocs / {narrow_bytes} B");
    println!("width:  wide(11x64) = {wide_count} allocs / {wide_bytes} B");

    assert_eq!(
        wide_count, narrow_count,
        "widening the parent rows changed the ALLOCATION COUNT ({narrow_count} → {wide_count}): the \
         leaf is allocating per CELL, i.e. copying rows instead of moving them"
    );

    // COUNT is the discriminator here and BYTES deliberately are not, which is worth stating because
    // the bytes DO grow with width and that growth is legitimate: appending the nesting key
    // reallocates each parent's own entry vector, and a wider row has a bigger one. Copied text and a
    // resized vector are both O(width) in bytes, so bytes cannot tell them apart — while in COUNT they
    // are unmistakable, since a resize is one allocation per parent however wide the row is and a copy
    // is one more per text cell.

    // ② NAME. Same rows, same children — only the relation name gets longer. A `to_string()` per
    // parent carries the name's bytes 200 times over; an interned key carries none of them.
    let (short_count, short_bytes) = cost(2, 8, "posts");
    let long_name = "posts_".repeat(24); // 144 bytes, still one relation
    let (long_count, long_bytes) = cost(2, 8, &long_name);

    println!(
        "name:   short({}) = {short_count} allocs / {short_bytes} B",
        "posts".len()
    );
    println!(
        "name:   long({})  = {long_count} allocs / {long_bytes} B",
        long_name.len()
    );

    assert_eq!(
        (long_count, long_bytes),
        (short_count, short_bytes),
        "lengthening the relation name changed what the leaf allocates: the nesting key is being \
         built per parent instead of interned once per call"
    );
}
