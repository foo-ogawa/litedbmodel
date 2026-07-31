"""ORM-bench native (ir-exec) conformance (#141 / epic #123, python leg) — ALL 19 ops.

Proves the litedbmodel python runtime runs the full covered surface (reads, single writes, batch
writes, RETURNING-chained transactions) through the bc-GENERATED ir-exec module
(``orm_bench.behaviors_generated``, verbatim ``bc generate --lang python``) bound to the op-agnostic
leaf transport (``make_handlers``) — the python literal path (ts/go/rust = native de-box; py/php =
literal). Pins: every op executes; batched relations are N+1-free; batch writes are ONE statement; the
RETURNING-chained transactions run through the runtime tx boundary (BEGIN + 2 body + COMMIT = 4
statements) and are ATOMIC (a mid-tx error commits nothing). Schema/seed/harness/safety-counter are
imported from the bench cell (``orm_bench.main``) — the SAME fixture the CSV cell measures (no
duplicated setup)."""

from __future__ import annotations

import pytest

from litedbmodel_runtime import as_context, with_transaction
from orm_bench.main import (
    BATCH_QUERY_COUNTS,
    OPS,
    RELATION_QUERY_COUNTS,
    TX_STMT_COUNTS,
    bound_ops,
    open_driver,
    probe,
    run_op,
    seed,
)


@pytest.fixture()
def harness():
    driver = open_driver("sqlite")
    seed(driver)
    return driver, bound_ops(driver, "sqlite")


def _users(driver):
    return driver.prepare("SELECT email FROM benchmark_users ORDER BY id").all([])


# ── every op executes ───────────────────────────────────────────────────────────


def test_every_op_executes(harness):
    driver, fns = harness
    assert len(OPS) == 19
    for op in OPS:
        seed(driver)  # clean fixture per op (writes mutate)
        assert run_op(fns, driver, "sqlite", op, 0) is not None or op in ("delete",)  # every op runs, returns a value


# ── reads + relations ─────────────────────────────────────────────────────────


def test_find_ops_return_expected_rows(harness):
    driver, fns = harness
    assert len(run_op(fns, driver, "sqlite", "findAll", 0)) == 100  # the op's LIMIT 100 over the seed SSoT
    unique = run_op(fns, driver, "sqlite", "findUnique", 0)
    # The declared input for this op (benchmark/crosslang/contract.ts) — the row the fixture is built
    # to answer and the row the ORM-vs-ORM column reads.
    assert len(unique) == 1 and unique[0]["email"] == "user500@example.com"
    assert len(run_op(fns, driver, "sqlite", "findFirst", 0)) == 1


def test_nested_relations_hydrate_children(harness):
    driver, fns = harness
    # The children are batch-loaded (N+1-free) and grouped onto the RIGHT parent: user 1 owns the seed's
    # first contiguous run of posts, and that post's comments are the first contiguous run of comments.
    # The fan-out itself is the fixture's, which the scale knob varies (#170), so the assertion pins the
    # SHAPE — the empty-children bug (#150) still fails it, a re-scaled fixture does not.
    users = run_op(fns, driver, "sqlite", "nestedFindAll", 0)
    by_id = {u["id"]: u for u in users}
    posts = by_id[1]["posts"]
    assert posts and [p["title"] for p in posts] == [f"Post {i}" for i in range(1, len(posts) + 1)]
    deep = run_op(fns, driver, "sqlite", "nestedRelations", 0)
    u1 = next(u for u in deep if u["id"] == 1)
    comments = u1["posts"][0]["comments"]  # 3-level chain
    assert comments and [c["id"] for c in comments] == list(range(1, len(comments) + 1))


def test_composite_relations_group_by_full_tuple(harness):
    driver, fns = harness
    tenants = run_op(fns, driver, "sqlite", "compositeRelations", 0)
    tu1 = next(t for t in tenants if t["user_id"] == 1)
    posts = tu1["posts"]
    # post_id / comment_id RESTART per tenant, so tenant 1 user 1 owns post_ids 1..n and post 1 owns
    # comment_ids 1..m — grouping on the FULL tuple is what keeps other tenants' identical ids out.
    assert posts and [p["post_id"] for p in posts] == list(range(1, len(posts) + 1))
    comments = posts[0]["comments"]
    assert comments and [c["comment_id"] for c in comments] == list(range(1, len(comments) + 1))


# ── single writes (executeSQL write path: summary for INSERT, RETURNING rows for upsert) ────────────


def test_single_writes_persist(harness):
    driver, fns = harness
    # create: INSERT (write, no returning) → one-row summary; the row persists.
    summary = run_op(fns, driver, "sqlite", "create", 7)
    assert summary[0]["changes"] == 1
    assert any(r["email"] == "new7@bench.com" for r in _users(driver))
    # update: SET name WHERE id=1 → summary; the row is updated.
    run_op(fns, driver, "sqlite", "update", 0)
    assert driver.prepare("SELECT name FROM benchmark_users WHERE id=1").all([])[0]["name"] == "Updated 1"
    # upsert: INSERT ... ON CONFLICT DO UPDATE RETURNING id (existing email) → the RETURNING row.
    returning = run_op(fns, driver, "sqlite", "upsert", 0)
    assert returning[0]["id"] == 1  # user1 conflict-updated, RETURNING its id
    assert driver.prepare("SELECT name FROM benchmark_users WHERE id=1").all([])[0]["name"] == "Upserted One"


# ── batch writes: ONE json_each/JSON_TABLE statement for N records ─────────────────────────────────


def test_batch_writes_apply_all_rows(harness):
    driver, fns = harness
    run_op(fns, driver, "sqlite", "createMany", 0)  # 10 fresh rows
    emails = {r["email"] for r in _users(driver)}
    assert all(f"many0_{i}@bench.com" in emails for i in range(10))
    run_op(fns, driver, "sqlite", "updateMany", 0)  # keyed on id 1..10
    assert driver.prepare("SELECT name FROM benchmark_users WHERE id=1").all([])[0]["name"] == "Many 1"


# ── RETURNING-chained transactions through the runtime tx boundary ────────────────────────────────


def test_nested_create_tx_persists_user_and_post(harness):
    driver, fns = harness
    run_op(fns, driver, "sqlite", "nestedCreate", 3)  # INSERT user RETURNING id → INSERT post(author_id=id)
    user = driver.prepare("SELECT id FROM benchmark_users WHERE email='nc3@bench.com'").all([])
    assert len(user) == 1
    posts = driver.prepare("SELECT title FROM benchmark_posts WHERE author_id=?").all([user[0]["id"]])
    assert [p["title"] for p in posts] == ["NC Post"]  # the dependent write committed together


def test_tx_atomicity_rolls_back_on_error(harness):
    """Mirror rust `tx_commits_on_ok_and_rolls_back_on_err`: a mid-tx error commits NOTHING. The write
    runs through the GENERATED `create` op + the leaf on the tx-pinned connection; the body then raises,
    so `with_transaction` ROLLs back — the inserted row must be absent."""
    driver, fns = harness
    before = len(_users(driver))

    class _Boom(RuntimeError):
        pass

    def body(_tx_ctx):
        fns["create"]({"email": "rollback@bench.com", "name": "RB"})  # insert on the pinned tx conn
        raise _Boom()  # mid-tx failure → ROLLBACK

    with pytest.raises(_Boom):
        with_transaction(as_context(driver), body)

    after = _users(driver)
    assert len(after) == before  # nothing committed
    assert not any(r["email"] == "rollback@bench.com" for r in after)  # the insert was rolled back

    # COMMIT path (control): the same op through the boundary DOES persist.
    with_transaction(as_context(driver), lambda _c: fns["create"]({"email": "committed@bench.com", "name": "OK"}))
    assert any(r["email"] == "committed@bench.com" for r in _users(driver))


# ── safety statement counts (via the runtime middleware seam) ──────────────────────────────────────


def test_safety_statement_counts(harness):
    driver, fns = harness
    expected = {**RELATION_QUERY_COUNTS, **BATCH_QUERY_COUNTS, **TX_STMT_COUNTS}
    counts = {op: probe(driver, fns, "sqlite", op)["stmts"] for op in expected}
    assert counts == expected  # relations 2/2/2/3/3, batch 1/1/1, tx 4/4/4/4


def test_probe_reports_the_rows_a_relation_op_moves(harness):
    driver, fns = harness
    # The per-row denominator the report divides by (#170). A relation op reads a 100-parent window and
    # both child levels under it, so its row total is far greater than its 3 statements — the property the
    # 110-user fixture hid by making it 700 rows against the ORM bench's 11,100.
    assert probe(driver, fns, "sqlite", "nestedRelations")["rows"] > probe(driver, fns, "sqlite", "findAll")["rows"]
