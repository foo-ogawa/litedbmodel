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

Usage: ``python -m orm_bench_sdk.main <dialect> <spec> [reps] [warmup]`` or
``python -m orm_bench_sdk.main safety <dialect> <spec>``.
"""

from __future__ import annotations

import os
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
        return [tuple(r) for r in rows]

    def exec(self, sql: str, params: tuple = ()) -> None:
        self.count += 1
        self._cursor(sql, params)

    def upsert_tail(self, cols: str) -> str:
        """The dialect's upsert tail for a UNIQUE `email` (the rust SDK cell's `upsert_tail` twin).
        PostgreSQL / SQLite take `ON CONFLICT`; MySQL takes `ON DUPLICATE KEY UPDATE`."""
        if self.dialect == "mysql":
            return " ON DUPLICATE KEY UPDATE " + ", ".join(f"{c} = VALUES({c})" for c in cols.split(", "))
        return " ON CONFLICT (email) DO UPDATE SET " + ", ".join(f"{c} = excluded.{c}" for c in cols.split(", "))

    def insert_user_id(self, email: str, name: str) -> int:
        """INSERT one user and return its generated id — through the seam, so it is counted. PostgreSQL
        appends `RETURNING id`; sqlite/mysql read the driver's last-insert id (the rust SDK cell's
        `insert_returning_id` twin)."""
        if self.dialect == "postgres":
            return int(self.query("INSERT INTO benchmark_users (email, name) VALUES (?, ?) RETURNING id", (email, name))[0][0])
        cur = self._cursor("INSERT INTO benchmark_users (email, name) VALUES (?, ?)", (email, name))
        self.count += 1
        return int(cur.lastrowid)

    def exec_script(self, sql: str) -> None:
        # param-free control statement (BEGIN / COMMIT)
        self.count += 1
        self._cursor(sql, ())


def open_db(spec: str = "sqlite") -> Db:
    """The raw driver connection for ONE target — the SAME database the native cell of that dialect uses
    (#145 invariant 1), seeded from the SAME `.setup/<dialect>.json` (invariant 2). Autocommit
    everywhere, so the explicit BEGIN/COMMIT below bracket exactly one tx, as the native cell's driver
    does. No litedbmodel runtime, no generated module — raw driver only (invariant 6). An unknown or
    unreachable target is a LOUD failure."""
    setup = lm_bench_setup.load(spec)
    if spec == "sqlite":
        conn = sqlite3.connect(":memory:", isolation_level=None, cached_statements=64)
    elif spec == "postgres":
        import psycopg  # lazy: the sqlite pilot never needs it

        conn = psycopg.connect(
            host=os.environ.get("TEST_DB_HOST", "localhost"),
            port=int(os.environ.get("TEST_DB_PORT", "5433")),
            user=os.environ.get("TEST_DB_USER", "testuser"),
            password=os.environ.get("TEST_DB_PASSWORD", "testpass"),
            dbname=os.environ.get("TEST_DB_NAME", "testdb"),
            autocommit=True,
        )
    elif spec == "mysql":
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
        raise SystemExit(f"orm_bench_sdk: unknown target {spec!r} (sqlite|postgres|mysql)")
    db = Db(conn, spec)
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


def _placeholders(n: int) -> str:
    return ",".join(["?"] * n)


def _tuple_in(rows: int, cols: int, dialect: str = "sqlite") -> str:
    """The composite key-set operand of `(k1,k2) IN …`. PostgreSQL / SQLite take a `(VALUES (…),(…))`
    constructor; MySQL takes a bare row list `((…),(…))` (the rust SDK cell's `tuple_in` twin)."""
    one = "(" + _placeholders(cols) + ")"
    body = ",".join([one] * rows)
    return "(" + body + ")" if dialect == "mysql" else "(VALUES " + body + ")"


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


def _materialize_users_posts(db: Db, user_rows: List[tuple]) -> List[User]:
    users = [User(r[0], r[1], r[2]) for r in user_rows]
    if not users:
        return users
    ids = [u.id for u in users]
    sql = ("SELECT id, title, author_id FROM benchmark_posts WHERE author_id IN (%s) ORDER BY id ASC"
           % _placeholders(len(ids)))
    posts = [Post(r[0], r[1], r[2]) for r in db.query(sql, tuple(ids))]
    by_author: dict = {}
    for p in posts:
        by_author.setdefault(p.author_id, []).append(p)
    for u in users:
        u.posts = by_author.pop(u.id, [])  # MOVE the grouped list into the parent
    return users


def _materialize_users_posts_comments(db: Db, user_rows: List[tuple]) -> List[User]:
    users = [User(r[0], r[1], r[2]) for r in user_rows]
    if not users:
        return users
    uids = [u.id for u in users]
    psql = ("SELECT id, title, author_id FROM benchmark_posts WHERE author_id IN (%s) ORDER BY id ASC"
            % _placeholders(len(uids)))
    posts = [Post(r[0], r[1], r[2]) for r in db.query(psql, tuple(uids))]
    if posts:
        pids = [p.id for p in posts]
        csql = ("SELECT id, body, post_id FROM benchmark_comments WHERE post_id IN (%s) ORDER BY id ASC"
                % _placeholders(len(pids)))
        comments = [Comment(r[0], r[1], r[2]) for r in db.query(csql, tuple(pids))]
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


def _materialize_composite(db: Db) -> List[TenantUser]:
    tusers = [TenantUser(r[0], r[1], r[2]) for r in db.query(
        "SELECT tenant_id, user_id, name FROM benchmark_tenant_users WHERE tenant_id = ? ORDER BY user_id ASC",
        (1,))]
    if not tusers:
        return tusers
    pbody = _tuple_in(len(tusers), 2, db.dialect)
    psql = ("SELECT tenant_id, post_id, user_id, title FROM benchmark_tenant_posts "
            "WHERE (tenant_id, user_id) IN " + pbody)
    pparams: list = []
    for u in tusers:
        pparams += [u.tenant_id, u.user_id]
    tposts = [TenantPost(r[0], r[1], r[2], r[3]) for r in db.query(psql, tuple(pparams))]
    if tposts:
        cbody = _tuple_in(len(tposts), 2, db.dialect)
        csql = ("SELECT tenant_id, comment_id, post_id, body FROM benchmark_tenant_comments "
                "WHERE (tenant_id, post_id) IN " + cbody)
        cparams: list = []
        for p in tposts:
            cparams += [p.tenant_id, p.post_id]
        tcomments = [TenantComment(r[0], r[1], r[2], r[3]) for r in db.query(csql, tuple(cparams))]
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


def _update_many(db: Db) -> None:
    _, names = batch_rows(0, False)
    whens = ""
    params: list = []
    for k in range(10):
        whens += " WHEN ? THEN ?"
        params += [k + 1, names[k]]
    params += [k + 1 for k in range(10)]
    sql = "UPDATE benchmark_users SET name = CASE id%s END WHERE id IN (%s)" % (whens, _placeholders(10))
    db.exec(sql, tuple(params))


def _batch_insert(db: Db, emails: List[str], names: List[str], conflict: str) -> None:
    tuples = ",".join(["(?, ?)"] * 10)
    params: list = []
    for k in range(10):
        params += [emails[k], names[k]]
    db.exec("INSERT INTO benchmark_users (email, name) VALUES " + tuples + conflict, tuple(params))


# ── the 19 ops (native-cell order). Fixed inputs mirror the python native cell; mutating ops vary their
#    UNIQUE column by it. Read LIMIT/ORDER shapes match the ops SSoT (== the native generated SQL). ────
def run_op(db: Db, op: str, it: int) -> None:
    if op == "findAll":
        db.query("SELECT id, email, name FROM benchmark_users ORDER BY id ASC LIMIT 100")
    elif op == "filterPaginateSort":
        db.query("SELECT id, title, content, published, author_id, created_at FROM benchmark_posts "
                 "WHERE published = ? ORDER BY created_at DESC LIMIT 20 OFFSET 10", (1,))
    elif op == "findFirst":
        db.query("SELECT id, email, name FROM benchmark_users WHERE name LIKE ? LIMIT 1", ("User%",))
    elif op == "findUnique":
        db.query("SELECT id, email, name FROM benchmark_users WHERE email = ? LIMIT 1", ("user1@example.com",))
    elif op == "nestedFindAll":
        _SINK[0] = _materialize_users_posts(db, db.query("SELECT id, email, name FROM benchmark_users ORDER BY id ASC LIMIT 100"))
    elif op == "nestedFindFirst":
        _SINK[0] = _materialize_users_posts(db, db.query("SELECT id, email, name FROM benchmark_users WHERE name LIKE ? LIMIT 1", ("User%",)))
    elif op == "nestedFindUnique":
        _SINK[0] = _materialize_users_posts(db, db.query("SELECT id, email, name FROM benchmark_users WHERE email = ? LIMIT 1", ("user1@example.com",)))
    elif op == "nestedRelations":
        users = db.query("SELECT id, email, name FROM benchmark_users ORDER BY id ASC LIMIT 100")
        _SINK[0] = _materialize_users_posts_comments(db, users)
    elif op == "compositeRelations":
        _SINK[0] = _materialize_composite(db)
    elif op == "create":
        db.exec("INSERT INTO benchmark_users (email, name) VALUES (?, ?)", (f"new{it}@bench.com", "New"))
    elif op == "update":
        db.exec("UPDATE benchmark_users SET name = ? WHERE id = ?", ("Updated 1", 1))
    elif op == "upsert":
        db.exec("INSERT INTO benchmark_users (email, name) VALUES (?, ?) "
                + db.upsert_tail("email, name"),
                ("user1@example.com", "Upserted One"))
    elif op == "createMany":
        emails, names = batch_rows(it, False)
        _batch_insert(db, emails, names, "")
    elif op == "upsertMany":
        emails = ["user1@example.com", "user2@example.com"] + [f"many{k}@bench.com" for k in range(8)]
        _, names = batch_rows(it, True)
        _batch_insert(db, emails, names, db.upsert_tail("email, name"))
    elif op == "updateMany":
        _update_many(db)
    elif op == "nestedCreate":
        db.exec_script("BEGIN")
        uid = db.insert_user_id(f"nc{it}@bench.com", "NC")
        db.exec("INSERT INTO benchmark_posts (author_id, title) VALUES (?, ?)", (uid, "NC Post"))
        db.exec_script("COMMIT")
    elif op == "nestedUpsert":
        db.exec_script("BEGIN")
        db.exec("INSERT INTO benchmark_users (email, name) VALUES (?, ?) "
                + db.upsert_tail("email, name"),
                ("user1@example.com", "NUp"))
        rows = db.query("SELECT id FROM benchmark_users WHERE email = ?", ("user1@example.com",))
        db.exec("INSERT INTO benchmark_posts (author_id, title) VALUES (?, ?)", (rows[0][0], "NUp Post"))
        db.exec_script("COMMIT")
    elif op == "nestedUpdate":
        db.exec_script("BEGIN")
        db.exec("UPDATE benchmark_users SET name = ? WHERE id = ?", ("NU", 1))
        db.exec("UPDATE benchmark_posts SET title = ? WHERE author_id = ?", ("NU Post", 1))
        db.exec_script("COMMIT")
    elif op == "delete":
        db.exec_script("BEGIN")
        uid = db.insert_user_id(f"del{it}@bench.com", "Del")
        db.exec("DELETE FROM benchmark_users WHERE id = ?", (uid,))
        db.exec_script("COMMIT")
    else:
        raise ValueError(f"unknown op {op!r}")


# ── safety expectations (mirror the native cell) ──────────────────────────────────────────────────
RELATION_QUERY_COUNTS = {"nestedFindAll": 2, "nestedFindFirst": 2, "nestedFindUnique": 2,
                         "nestedRelations": 3, "compositeRelations": 3}
BATCH_QUERY_COUNTS = {"createMany": 1, "upsertMany": 1, "updateMany": 1}
# tx: BEGIN + body + COMMIT. nestedUpsert re-SELECTs the id (upsert has no portable RETURNING) → 5.
TX_STMT_COUNTS = {"nestedCreate": 4, "nestedUpsert": 5, "nestedUpdate": 4, "delete": 4}


def _measure(dialect: str, spec: str, reps: int, warmup: int) -> None:
    db = open_db(spec)
    print("cell,dialect,op,iter,us")
    for op in OPS:
        seed(db)  # re-seed before each op (matches the native cell)
        for it in range(warmup):
            run_op(db, op, it)
        for it in range(reps):
            g = it + warmup
            t = time.perf_counter_ns()
            run_op(db, op, g)
            us = (time.perf_counter_ns() - t) // 1000
            print(f"sdk,{dialect},{op},{it},{us}")


def _safety(dialect: str, spec: str) -> None:
    db = open_db(spec)
    expected = {**RELATION_QUERY_COUNTS, **BATCH_QUERY_COUNTS, **TX_STMT_COUNTS}
    for op, want in expected.items():
        seed(db)
        db.count = 0
        run_op(db, op, 0)
        got = db.count
        assert got == want, f"{op} statement-count regression: got {got}, expect {want}"
        kind = "queries" if op not in TX_STMT_COUNTS else "statements (BEGIN + body + COMMIT)"
        print(f"{op} {kind}={got} (expect {want})")


def main(argv: List[str]) -> None:
    if argv and argv[0] == "safety":
        _safety(argv[1] if len(argv) > 1 else "sqlite", argv[2] if len(argv) > 2 else "sqlite")
        return
    dialect = argv[0] if argv else "sqlite"
    spec = argv[1] if len(argv) > 1 else "sqlite"
    reps = int(argv[2]) if len(argv) > 2 else 300
    warmup = int(argv[3]) if len(argv) > 3 else 30
    _measure(dialect, spec, reps, warmup)


if __name__ == "__main__":
    main(sys.argv[1:])
