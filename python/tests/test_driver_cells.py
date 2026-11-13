"""#363 — the live driver's cell canonicalization (``driver._scalar``) keeps every cell's exact value.

psycopg (NUMERIC / BYTEA) and PyMySQL (DECIMAL / BINARY) hand those cells back as ``decimal.Decimal`` /
``bytes``. ``_scalar`` used to round a Decimal through ``float`` and decode bytes with
``errors='replace'``, so two different rows came back with ONE key: ``pluck`` deduped the two parents to
one key and ``group`` attached one parent's children to both. The rows here are fed through the real
pooled-row path (``_conn_all`` → ``_fetch_all`` → ``_scalar``) by a DB-API cursor shaped like those
drivers, then through the real relation leaves.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from litedbmodel_runtime.driver import SqliteDriver, _conn_all
from litedbmodel_runtime.leaves import make_handlers


class _Cursor:
    """A DB-API cursor returning scripted rows, as psycopg / PyMySQL return NUMERIC and BYTEA cells."""

    def __init__(self, conn: "_Conn") -> None:
        self._conn = conn
        self.description = None
        self._rows: list = []

    def execute(self, sql, params) -> None:
        self._conn.sent.append(params)
        cols, rows = self._conn.script.pop(0)
        self.description = [(c,) for c in cols]
        self._rows = rows

    def fetchall(self) -> list:
        return self._rows

    def close(self) -> None:
        pass


class _Conn:
    def __init__(self, *script) -> None:
        self.script = list(script)
        self.sent: list = []

    def cursor(self) -> _Cursor:
        return _Cursor(self)


def _rows(conn: _Conn, sql: str = "SELECT 1"):
    return _conn_all(conn, sql, [], lambda s: s, False)


def test_decimal_cells_round_trip_exactly() -> None:
    rows = _rows(
        _Conn(
            (
                ["a", "b", "c", "d"],
                [(Decimal("9007199254740993"), Decimal("12345.123456789012345678"), Decimal("1E-7"), Decimal("NaN"))],
            )
        )
    )
    assert rows == [{"a": 9007199254740993, "b": "12345.123456789012345678", "c": "0.0000001", "d": "NaN"}]


def test_adjacent_big_numeric_parents_keep_their_own_children() -> None:
    parents = _rows(
        _Conn((["id", "owner"], [(Decimal("9007199254740992"), "A"), (Decimal("9007199254740993"), "B")]))
    )
    leaves = make_handlers(SqliteDriver.in_memory([]), "postgres")
    keys = leaves["pluck"]({"rows": parents, "col": ["id"]}, {})["ok"]
    assert keys == [9007199254740992, 9007199254740993]

    children = _rows(
        _Conn(
            (
                ["id", "account_id"],
                [(1, Decimal("9007199254740992")), (2, Decimal("9007199254740993"))],
            )
        )
    )
    grouped = leaves["group"](
        {"parents": parents, "children": children, "pk": ["id"], "fk": ["account_id"], "into": "rows", "single": False},
        {},
    )["ok"]
    assert [(g["owner"], [c["id"] for c in g["rows"]]) for g in grouped] == [("A", [1]), ("B", [2])]


def test_bytes_cell_decodes_strictly() -> None:
    assert _rows(_Conn((["k"], [(b"\xe3\x81\x82k",)]))) == [{"k": "あk"}]
    # 'replace' turned this truncated sequence into the U+FFFD that a VALID cell `\xef\xbf\xbdk` spells too.
    with pytest.raises(UnicodeDecodeError):
        _rows(_Conn((["k"], [(b"\xf0\x90\x80k",)])))
