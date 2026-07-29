"""The FIND-context runaway guard primitive (#74 / #99, python port).

Pins :func:`check_find_hard_limit` and its SSoT core :meth:`LimitExceededError.check` behaviour-identical
to the rust ``check_find_hard_limit`` / ``LimitExceededError::check`` and the go ``CheckFindHardLimit``:
the compile injects ``LIMIT hardLimit + 1``, so a post-fetch ``count`` of ``hardLimit + 1`` means the
TRUE total exceeds the cap and the read fails LOUD (``context='find'``) instead of loading an unbounded
set. The 19 native ops bake explicit LIMITs, so the guard is not wired into them (same as rust/go) — it
is the available guard primitive, unit-tested here. The relation-context arm of the SAME core is pinned
in test_grouping / the relation path; this file pins the find arm + the shared comparison."""

from __future__ import annotations

import pytest

from litedbmodel_runtime import LimitExceededError, check_find_hard_limit


def test_within_cap_is_a_no_op():
    # count <= limit: the LIMIT cap+1 fetch returned at most `limit` rows ⇒ within cap, no raise.
    assert check_find_hard_limit(100, 100, "benchmark_users") is None
    assert check_find_hard_limit(100, 99, "benchmark_users") is None
    assert LimitExceededError.check(5, 5, "find", "m") is None


def test_over_cap_raises_find_context_error():
    # count == limit+1 (the injected LIMIT hardLimit+1 tripped): the true total exceeds the cap ⇒ LOUD.
    with pytest.raises(LimitExceededError) as ei:
        check_find_hard_limit(100, 101, "benchmark_users")
    e = ei.value
    assert e.name == "LimitExceededError"
    assert e.limit == 100 and e.count == 101
    assert e.context == "find" and e.model == "benchmark_users" and e.relation is None
    # find context reports "more than <limit>" (the cap+1 fetch only KNOWS the total exceeds the cap).
    assert "find() on benchmark_users returned more than 100 records" in str(e)
    assert "but limit is 100" in str(e)


def test_shared_check_core_is_context_parametric():
    # The SAME `count > limit ⇒ raise` core serves the relation context (exact count) too (SSoT).
    with pytest.raises(LimitExceededError) as ei:
        LimitExceededError.check(2, 7, "relation", "benchmark_posts", "posts")
    e = ei.value
    assert e.context == "relation" and e.count == 7 and e.relation == "posts"
    assert "relation 'posts' on benchmark_posts returned 7 records" in str(e)  # relation reports EXACT count


def test_relation_guard_trips_on_the_raw_child_rows():
    """The RELATION runaway guard (#160) inside the ``executeSQL`` leaf, over a real sqlite.

    The python leg of "the same behaviour in all five languages" — the twin of the rust
    ``relation_guard_trips_on_the_raw_child_rows``, the go ``TestExecuteSQL_RelationGuardOnRawChildRows``
    and the TS conformance guard vectors. Over the cap ⇒ the transport RAISES with the relation-context
    fields and the EXACT batch count, before the rows are handed on; within the cap ⇒ the rows come back;
    NO ``guard`` port ⇒ never checked (the byte-unchanged uncapped path).
    """
    import sqlite3

    from litedbmodel_runtime.driver import SqliteDriver
    from litedbmodel_runtime.leaves import make_handlers

    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
    conn.executemany("INSERT INTO t (id, v) VALUES (?, ?)", [(1, "a"), (2, "b"), (3, "c")])
    execute_sql = make_handlers(SqliteDriver(conn), "sqlite")["executeSQL"]
    ctx = {"nodeId": "n0", "component": "executeSQL"}

    def read(guard):
        # `guard` is the OPTIONAL relation cap (absent ⇒ uncapped); `whereDynamic` is likewise omitted
        # on this bounded read — both control ports are present-or-absent per call.
        ports = {"sql": "SELECT id, v FROM t ORDER BY id", "params": [], "write": False,
                 "returning": False, "bigint": False}
        if guard is not None:
            ports["guard"] = guard
        return execute_sql(ports, ctx)

    cap = lambda limit: {"limit": limit, "model": "t", "relation": "things"}  # noqa: E731

    # 3 rows > cap 2 ⇒ raises before the rows are handed on (an `{"error": …}` outcome would NOT do:
    # a runaway is a typed litedbmodel policy error, not a mapped transport failure).
    with pytest.raises(LimitExceededError) as ei:
        read(cap(2))
    e = ei.value
    assert e.limit == 2 and e.count == 3 and e.context == "relation"
    assert e.model == "t" and e.relation == "things"
    assert "relation 'things' on t returned 3 records, but limit is 2" in str(e)

    # 3 rows <= cap 3 ⇒ the rows come back untouched; no guard port at all ⇒ never checked.
    assert len(read(cap(3))["ok"]) == 3
    assert len(read(None)["ok"]) == 3
