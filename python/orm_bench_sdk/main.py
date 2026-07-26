"""Raw-driver SDK-baseline ORM-bench cell (python leg) — the apples-to-apples twin of
``orm_bench.main`` (the native-codegen cell).

It runs the SAME 19 ORM ops over the SAME canonical fixture and the SAME in-memory sqlite storage the
native cell uses (``sqlite3.connect(":memory:")`` ↔ the native's ``SqliteDriver.in_memory``), but every
op is HAND-WRITTEN SQL issued straight at the ``sqlite3`` driver connection. ``litedbmodel_runtime`` and
the bc-generated ``behaviors_generated`` module are NOT imported and NOT in the path.

Fairness (a strawman SDK invalidates the comparison):
  - SAME storage: in-memory sqlite (no file → no fsync/WAL the native in-memory cell never pays).
  - Prepared-statement REUSE: ``sqlite3`` caches the compiled statement by SQL text at the connection
    level (``cached_statements``), so re-issuing the same op's SQL reuses the prepared statement across
    iterations — matching the native runtime's prepared-statement cache, not a re-parse-per-call strawman.
  - N+1-FREE relations: parent read → pluck keys → ONE batched child read (WHERE fk IN (…)) → group in
    memory, the SAME query counts the native cell proves (nestedFindAll=2, nestedRelations=3,
    compositeRelations=3, batch write=1, RETURNING-chained tx = BEGIN + body + COMMIT).
  - SAME seed + inputs as the native twin: the small canonical nested fixture (mirrored from
    ``orm_bench.main`` — the fixture each isolated cell carries), re-seeded before each op, and the SAME
    per-op inputs (findUnique=user1, update id=1, …).

Usage: ``python -m orm_bench_sdk.main <dialect> [reps] [warmup]`` or
``python -m orm_bench_sdk.main safety <dialect>``.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
import time
from typing import Any, List

# The shared seed-SSoT loader lives at the python/ root (one dir above this package) — anchor its import
# to this file so it resolves regardless of cwd.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import lm_bench_setup  # noqa: E402

# ── schema + seed from the ONE seed SSoT (benchmark/crosslang/.setup/sqlite.json, emitted from
#    orm-domain.ts) — the SAME fixture the native twin loads. Shared TEST DATA, not covered code. ──
_SETUP = lm_bench_setup.load("sqlite")
SCHEMA: List[str] = _SETUP["schema"]  # drop + create, applied once at open
SEED: List[str] = _SETUP["delete"] + _SETUP["insert"]  # empty + the canonical 110-user fixture, per op

OPS: List[str] = [
    "findAll", "filterPaginateSort", "findFirst", "findUnique",
    "nestedFindAll", "nestedFindFirst", "nestedFindUnique", "nestedRelations", "compositeRelations",
    "create", "update", "upsert", "createMany", "upsertMany", "updateMany",
    "nestedCreate", "nestedUpsert", "nestedUpdate", "delete",
]

# ── the ONE exec seam. All DB access rides these methods, so the statement counter (safety proof) lives
#    in one place. Prepared-statement reuse is the sqlite3 connection's own statement cache. ──────────
class Db:
    """The ONE exec seam. All DB access rides these methods, so the statement counter (the safety proof)
    lives in one place, and the DIALECT lives here too: `sql()` renders this connection's placeholder
    style, so every op below writes `?` once and the seam adapts it. Prepared-statement reuse is the
    driver's own statement cache (sqlite3 by SQL text; psycopg / PyMySQL server-side)."""

    def __init__(self, conn: Any, dialect: str = "sqlite") -> None:
        self.conn = conn
        self.dialect = dialect
        self.count = 0
        # Rows this hand-written baseline scanned (#170) — the report's per-row denominator, and the
        # proof the baseline moved the SAME rows the native cell did (a baseline that fetched fewer
        # would post a flattering ratio).
        self.rows = 0

    def sql(self, sql: str) -> str:
        """`?` → the driver's placeholder. psycopg and PyMySQL both bind `%s` positionally; sqlite3 takes
        `?` as written. A literal `%` is doubled for the two `%s` drivers."""
        if self.dialect == "sqlite":
            return sql
        return sql.replace("%", "%%").replace("?", "%s")

    def _cursor(self, sql: str, params: tuple):
        # sqlite3's Connection.execute RETURNS the cursor; psycopg / PyMySQL execute ON one.
        if self.dialect == "sqlite":
            return self.conn.execute(sql, tuple(params))
        cur = self.conn.cursor()
        cur.execute(self.sql(sql), tuple(params))
        return cur

    def query(self, sql: str, params: tuple = ()) -> List[tuple]:
        self.count += 1
        cur = self._cursor(sql, params)
        rows = cur.fetchall()
        self.rows += len(rows)
        return [tuple(r) for r in rows]

    def exec(self, sql: str, params: tuple = ()) -> None:
        self.count += 1
        self._cursor(sql, params)

    def write_returning_id(self, sql: str, params: tuple, recover_sql: str, recover_params: tuple = ()) -> int:
        """A write that hands back the id of the row it wrote — the `` RETURNING id`` the authored native
        module declares for every id-chaining write (``benchmark/crosslang/native-model.ts``). The baseline
        issues the SAME statement and reads the SAME row back, so the two surfaces do equal work.

        MySQL has no RETURNING: the runtime's mysql adapter strips the clause and recovers the written rows
        with a keyed SELECT on the same connection (``src/scp/makesql/mysql-returning.ts``). ``recover_sql``
        is that same recovery. It belongs to the SAME logical statement — the runtime's seam counts a MySQL
        RETURNING write as one (its recovery runs below the seam) while counting the row it recovers — so
        the rows are tallied here and the statement count is not bumped a second time.
        """
        if self.dialect != "mysql":
            return int(self.query(sql, params)[0][0])
        # MySQL cannot parse RETURNING: strip the clause (and the /*scp:pk=…*/ hint naming the key) exactly
        # as the runtime's mysql adapter does, then recover the written row with the keyed SELECT.
        self.exec(re.sub(r"\s+RETURNING\s+.*$", "", sql, flags=re.S | re.I), params)
        return int(self._recover_rows(recover_sql, recover_params)[0][0])

    def _recover_rows(self, sql: str, params: tuple) -> List[tuple]:
        """Fetch belonging to the logical statement just issued: rows tallied, statement count not bumped."""
        cur = self._cursor(sql, params)
        rows = [tuple(r) for r in cur.fetchall()]
        self.rows += len(rows)
        return rows

    def exec_script(self, sql: str) -> None:
        # param-free control statement (BEGIN / COMMIT)
        self.count += 1
        self._cursor(sql, ())


def open_db(dialect: str = "sqlite") -> Db:
    """The raw driver connection for ONE target — the SAME database the native cell of that dialect uses
    (#145 invariant 1), seeded from the SAME `.setup/<dialect>.json` (invariant 2). Autocommit
    everywhere, so the explicit BEGIN/COMMIT below bracket exactly one tx, as the native cell's driver
    does. No litedbmodel runtime, no generated module — raw driver only (invariant 6). An unknown or
    unreachable target is a LOUD failure."""
    setup = lm_bench_setup.load(dialect)
    if dialect == "sqlite":
        conn = sqlite3.connect(":memory:", isolation_level=None, cached_statements=64)
    elif dialect == "postgres":
        import psycopg  # lazy: the sqlite pilot never needs it

        conn = psycopg.connect(
            host=os.environ.get("TEST_DB_HOST", "localhost"),
            port=int(os.environ.get("TEST_DB_PORT", "5433")),
            user=os.environ.get("TEST_DB_USER", "testuser"),
            password=os.environ.get("TEST_DB_PASSWORD", "testpass"),
            dbname=os.environ.get("TEST_DB_NAME", "testdb"),
            autocommit=True,
        )
    elif dialect == "mysql":
        import pymysql  # lazy

        conn = pymysql.connect(
            host=os.environ.get("TEST_MYSQL_HOST", "127.0.0.1"),
            port=int(os.environ.get("TEST_MYSQL_PORT", "3307")),
            user=os.environ.get("TEST_MYSQL_USER", "testuser"),
            password=os.environ.get("TEST_MYSQL_PASSWORD", "testpass"),
            database=os.environ.get("TEST_MYSQL_DB", "testdb"),
            autocommit=True,
        )
    else:
        raise SystemExit(f"orm_bench_sdk: unknown target {dialect!r} (sqlite|postgres|mysql)")
    db = Db(conn, dialect)
    for stmt in setup["schema"]:
        db.exec_script(stmt)
    db.count = 0
    return db


def seed(db: Db) -> None:
    """DELETE + INSERT this target's canonical fixture, off-seam so it is never counted."""
    setup = lm_bench_setup.load(db.dialect)
    for stmt in setup["delete"] + setup["insert"]:
        if db.dialect == "sqlite":
            db.conn.execute(stmt)
        else:
            db.conn.cursor().execute(stmt)


# ── batch-write inputs (mirror ops.ts / the native cell) ───────────────────────────────────────────
def batch_rows(it: int, stable: bool) -> tuple:
    emails = [(f"many{i}@bench.com" if stable else f"many{it}_{i}@bench.com") for i in range(10)]
    names = [f"Many {i}" for i in range(10)]
    return emails, names


# ── nested materialization (fair vs the native cell) ───────────────────────────────────────────────
# The native ORM assembles a nested TYPED object graph: each parent record with its child list nested
# under the relation key (the runtime group_children builds it; the generated de-box holds it). The SDK
# mirrors that — decode every selected column into a plain typed record (a __slots__ class) and ATTACH the
# grouped children into their parent BY MOVE (drain the group map into ``parent.children``, no per-parent
# copy). The fully-assembled list-of-parents is held in ``_SINK`` so it isn't dropped before timing ends.
#
# The payload fields (email/name/title/body) are decoded-then-held (the same decode the native pays) but
# never read downstream — only the key columns drive the grouping.
class User:
    __slots__ = ("id", "email", "name", "posts")

    def __init__(self, id: Any, email: Any, name: Any) -> None:
        self.id = id
        self.email = email
        self.name = name
        self.posts: list = []


class Post:
    __slots__ = ("id", "title", "author_id", "comments")

    def __init__(self, id: Any, title: Any, author_id: Any) -> None:
        self.id = id
        self.title = title
        self.author_id = author_id
        self.comments: list = []


class Comment:
    __slots__ = ("id", "body", "post_id")

    def __init__(self, id: Any, body: Any, post_id: Any) -> None:
        self.id = id
        self.body = body
        self.post_id = post_id


class TenantUser:
    __slots__ = ("tenant_id", "user_id", "name", "posts")

    def __init__(self, tenant_id: Any, user_id: Any, name: Any) -> None:
        self.tenant_id = tenant_id
        self.user_id = user_id
        self.name = name
        self.posts: list = []


class TenantPost:
    __slots__ = ("tenant_id", "post_id", "user_id", "title", "comments")

    def __init__(self, tenant_id: Any, post_id: Any, user_id: Any, title: Any) -> None:
        self.tenant_id = tenant_id
        self.post_id = post_id
        self.user_id = user_id
        self.title = title
        self.comments: list = []


class TenantComment:
    __slots__ = ("tenant_id", "comment_id", "post_id", "body")

    def __init__(self, tenant_id: Any, comment_id: Any, post_id: Any, body: Any) -> None:
        self.tenant_id = tenant_id
        self.comment_id = comment_id
        self.post_id = post_id
        self.body = body


# Holds the last materialized graph so it isn't dropped before the timed op ends (the python analogue of
# the rust cell's black_box(&roots)).
_SINK: list = [None]


_PG_ARRAY_CAST = re.compile(r"::\w+\[\]")


def _pg_array_literal(values: list) -> str:
    """A PostgreSQL array literal (``{1,2,3}``), bound as TEXT and cast by the statement's own ``::int[]`` /
    ``::text[]`` — so it needs no driver-specific array support."""
    def one(v):
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            return str(v)
        return '"' + str(v).replace("\\", "\\\\").replace('"', '\\"') + '"'
    return "{" + ",".join(one(v) for v in values) + "}"


def _key_param(tuples: List[tuple], sql: str) -> str:
    """One relation level's key set as the ONE param the captured SQL expects. The generated module binds a
    batched child read's key set as a single param, never as N placeholders — so the baseline binds it the
    same way, or it is running different SQL.

    The statement says which encoding it wants: an ARRAY cast (``$1::int[]``, PostgreSQL's single-key
    predicate) takes a PostgreSQL array literal; a ``::json`` cast and MySQL/SQLite's ``json_each`` /
    ``JSON_TABLE`` take JSON. Reading it off the SQL keeps the encoding tied to the statement."""
    keys = [t[0] if len(t) == 1 else list(t) for t in tuples]
    return _pg_array_literal(keys) if _PG_ARRAY_CAST.search(sql) else json.dumps(keys)


def _batch_params(db: Db, records: List[dict], sql: str) -> tuple:
    """A batch write's record set as the param(s) the captured statement expects: ONE JSON array on
    MySQL/SQLite, one array PER COLUMN on PostgreSQL (its ``UNNEST`` form takes column arrays). The payload
    repeats once per ``?`` — updateMany's SET subquery and its WHERE each read it."""
    if db.dialect == "postgres":
        one = [_pg_array_literal([r[c] for r in records]) for c in sorted(records[0])]
    else:
        one = [json.dumps(records)]
    reps = max(1, round(sql.count("?") / len(one)))
    return tuple(one * reps)


# The keyed SELECTs the runtime's MySQL adapter recovers a RETURNING write's rows with
# (src/scp/makesql/mysql-returning.ts): the conflict key for an upsert, the AUTO_INCREMENT range for an
# insert, the write's own WHERE for an update. Only MySQL runs them — the others have RETURNING.
RECOVER_BY_EMAIL = "SELECT id FROM benchmark_users WHERE email = ?"
RECOVER_BY_LAST_INSERT_ID = "SELECT id FROM benchmark_users WHERE id = LAST_INSERT_ID()"
RECOVER_BY_ID = "SELECT id FROM benchmark_users WHERE id = ?"


def _user_records(it: int, stable: bool) -> List[dict]:
    emails, names = batch_rows(it, stable)
    return [{"email": emails[i], "name": names[i]} for i in range(10)]


def _patch_records() -> List[dict]:
    _, names = batch_rows(0, False)
    return [{"id": i + 1, "name": names[i]} for i in range(10)]


def _materialize_users_posts(db: Db, user_rows: List[tuple], child_sql: str) -> List[User]:
    users = [User(r[0], r[1], r[2]) for r in user_rows]
    if not users:
        return users
    posts = [Post(r[0], r[1], r[2]) for r in db.query(child_sql, (_key_param([(u.id,) for u in users], child_sql),))]
    by_author: dict = {}
    for p in posts:
        by_author.setdefault(p.author_id, []).append(p)
    for u in users:
        u.posts = by_author.pop(u.id, [])  # MOVE the grouped list into the parent
    return users


def _materialize_users_posts_comments(db: Db, user_rows: List[tuple], post_sql: str, comment_sql: str) -> List[User]:
    users = [User(r[0], r[1], r[2]) for r in user_rows]
    if not users:
        return users
    posts = [Post(r[0], r[1], r[2]) for r in db.query(post_sql, (_key_param([(u.id,) for u in users], post_sql),))]
    if posts:
        comments = [Comment(r[0], r[1], r[2]) for r in db.query(comment_sql, (_key_param([(p.id,) for p in posts], comment_sql),))]
        by_post: dict = {}
        for c in comments:
            by_post.setdefault(c.post_id, []).append(c)
        for p in posts:
            p.comments = by_post.pop(p.id, [])
    by_author: dict = {}
    for p in posts:
        by_author.setdefault(p.author_id, []).append(p)
    for u in users:
        u.posts = by_author.pop(u.id, [])
    return users


def _materialize_composite(db: Db, sql: List[str]) -> List[TenantUser]:
    tusers = [TenantUser(r[0], r[1], r[2]) for r in db.query(sql[0])]
    if not tusers:
        return tusers
    ukeys = _key_param([(u.tenant_id, u.user_id) for u in tusers], sql[1])
    tposts = [TenantPost(r[0], r[1], r[2], r[3]) for r in db.query(sql[1], (ukeys,))]
    if tposts:
        pkeys = _key_param([(p.tenant_id, p.post_id) for p in tposts], sql[2])
        tcomments = [TenantComment(r[0], r[1], r[2], r[3]) for r in db.query(sql[2], (pkeys,))]
        by_post: dict = {}
        for c in tcomments:
            by_post.setdefault((c.tenant_id, c.post_id), []).append(c)
        for p in tposts:
            p.comments = by_post.pop((p.tenant_id, p.post_id), [])
    by_user: dict = {}
    for p in tposts:
        by_user.setdefault((p.tenant_id, p.user_id), []).append(p)
    for u in tusers:
        u.posts = by_user.pop((u.tenant_id, u.user_id), [])
    return tusers


# ── the 19 ops (native-cell order). Fixed inputs mirror the python native cell; mutating ops vary their
#    UNIQUE column by it. Read LIMIT/ORDER shapes match the ops SSoT (== the native generated SQL). ────
def run_op(db: Db, op: str, it: int, sql: List[str]) -> None:
    """Run ONE op, issuing the statements the GENERATED module issues for this dialect (``sql`` =
    ``setup["ops"][op]``, captured at the runtime seam). The baseline hand-writes no SQL: the report
    divides native by sdk, which only isolates the runtime's cost if both send the DB the same statements.
    What stays hand-written is what a raw-driver user writes: param binding, decode, grouping children into
    parents, and the transaction bracket."""
    if op == "findAll":
        db.query(sql[0])
    elif op == "filterPaginateSort":
        db.query(sql[0], (1,))
    elif op == "findFirst":
        db.query(sql[0], ("User%",))
    elif op == "findUnique":
        db.query(sql[0], ("user1@example.com",))
    elif op == "nestedFindAll":
        _SINK[0] = _materialize_users_posts(db, db.query(sql[0]), sql[1])
    elif op == "nestedFindFirst":
        _SINK[0] = _materialize_users_posts(db, db.query(sql[0], ("User%",)), sql[1])
    elif op == "nestedFindUnique":
        _SINK[0] = _materialize_users_posts(db, db.query(sql[0], ("user1@example.com",)), sql[1])
    elif op == "nestedRelations":
        _SINK[0] = _materialize_users_posts_comments(db, db.query(sql[0]), sql[1], sql[2])
    elif op == "compositeRelations":
        _SINK[0] = _materialize_composite(db, sql)
    elif op == "create":
        db.exec(sql[0], (f"new{it}@bench.com", "New"))
    elif op == "update":
        db.exec(sql[0], ("Updated 1", 1))
    elif op == "upsert":
        # The captured statement declares ` RETURNING id`, so the baseline reads the id back too.
        _SINK[0] = db.write_returning_id(sql[0], ("user1@example.com", "Upserted One"),
                                        RECOVER_BY_EMAIL, ("user1@example.com",))
    elif op == "createMany":
        db.exec(sql[0], _batch_params(db, _user_records(it, False), sql[0]))
    elif op == "upsertMany":
        # The SAME 10 records the native module upserts.
        db.exec(sql[0], _batch_params(db, _user_records(it, True), sql[0]))
    elif op == "updateMany":
        db.exec(sql[0], _batch_params(db, _patch_records(), sql[0]))
    elif op == "nestedCreate":
        db.exec_script("BEGIN")
        uid = db.write_returning_id(sql[0], (f"nc{it}@bench.com", "NC"), RECOVER_BY_LAST_INSERT_ID)
        db.exec(sql[1], (uid, "NC Post"))
        db.exec_script("COMMIT")
    elif op == "nestedUpsert":
        db.exec_script("BEGIN")
        uid = db.write_returning_id(sql[0], ("user1@example.com", "NUp"), RECOVER_BY_EMAIL, ("user1@example.com",))
        db.exec(sql[1], (uid, "NUp Post"))
        db.exec_script("COMMIT")
    elif op == "nestedUpdate":
        db.exec_script("BEGIN")
        # The generated runner chains the dependent UPDATE off the id the first UPDATE returned; taking the
        # id from the input instead would skip a statement's worth of work.
        uid = db.write_returning_id(sql[0], ("NU", 1), RECOVER_BY_ID, (1,))
        db.exec(sql[1], ("NU Post", uid))
        db.exec_script("COMMIT")
    elif op == "delete":
        db.exec_script("BEGIN")
        uid = db.write_returning_id(sql[0], (f"del{it}@bench.com", "Del"), RECOVER_BY_LAST_INSERT_ID)
        db.exec(sql[1], (uid,))
        db.exec_script("COMMIT")
    else:
        raise ValueError(f"unknown op {op!r}")


# ── safety expectations (mirror the native cell) ──────────────────────────────────────────────────
RELATION_QUERY_COUNTS = {"nestedFindAll": 2, "nestedFindFirst": 2, "nestedFindUnique": 2,
                         "nestedRelations": 3, "compositeRelations": 3}
BATCH_QUERY_COUNTS = {"createMany": 1, "upsertMany": 1, "updateMany": 1}
# tx: BEGIN + body + COMMIT — the same count the native cell proves, since the baseline issues the same
# statements (a MySQL RETURNING write plus its recovery is ONE logical statement in both surfaces).
TX_STMT_COUNTS = {"nestedCreate": 4, "nestedUpsert": 4, "nestedUpdate": 4, "delete": 4}


def _measure(dialect: str, reps: int, warmup: int) -> None:
    db = open_db(dialect)
    ops = lm_bench_setup.load(dialect)["ops"]
    print("cell,dialect,op,iter,us,rows")
    for op in OPS:
        seed(db)  # re-seed before each op (matches the native cell)
        # One UN-TIMED probe per op measures the rows it moves — the report's per-row denominator (#170).
        db.rows = 0
        run_op(db, op, 0, ops[op])
        rows = db.rows
        for it in range(warmup):
            run_op(db, op, it + 1, ops[op])
        for it in range(reps):
            # Unique iteration id: the probe took 0, so warmup/timed start at 1.
            g = it + warmup + 1
            t = time.perf_counter_ns()
            run_op(db, op, g, ops[op])
            us = (time.perf_counter_ns() - t) // 1000
            print(f"sdk,{dialect},{op},{it},{us},{rows}")


def _safety(dialect: str) -> None:
    db = open_db(dialect)
    ops = lm_bench_setup.load(dialect)["ops"]
    expected = {**RELATION_QUERY_COUNTS, **BATCH_QUERY_COUNTS, **TX_STMT_COUNTS}
    print("op                    statements  rows")
    for op in OPS:
        seed(db)
        db.count = 0
        db.rows = 0
        run_op(db, op, 0, ops[op])
        got, rows = db.count, db.rows
        want = expected.get(op)
        mark = "ok" if want is None or got == want else f"STATEMENT-COUNT MISMATCH (want {want})"
        print(f"{op:<20}  {got:<10}  {rows:<6} {mark}")
        assert want is None or got == want, f"{op} statement-count regression: got {got}, expect {want}"


def main(argv: List[str]) -> None:
    if argv and argv[0] == "safety":
        _safety(argv[1] if len(argv) > 1 else "sqlite")
        return
    dialect = argv[0] if argv else "sqlite"
    reps = int(argv[1]) if len(argv) > 1 else 300
    warmup = int(argv[2]) if len(argv) > 2 else 30
    _measure(dialect, reps, warmup)


if __name__ == "__main__":
    main(sys.argv[1:])
