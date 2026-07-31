"""Render-layer placeholder resolution unit test — the leaf transport's `?`→`$N` step.

The dialect placeholder render (``render_placeholders``) is the render-layer step the leaf transport
(``leaves.execute_sql``) applies after the dynamic (SKIP) WHERE is assembled. This pins its
quote-aware edge directly; the byte-for-byte SQL is otherwise pinned by the frozen vector corpus.
"""

from __future__ import annotations

from litedbmodel_runtime.leaves import render_placeholders


def test_placeholder_rewrite_quote_aware():
    # A `?` inside a string literal is NOT a placeholder (mirrors TS renderPlaceholders).
    assert render_placeholders("SELECT '?' AS q WHERE a = ?", "postgres") == "SELECT '?' AS q WHERE a = $1"
    assert render_placeholders("a = ? AND b = ?", "sqlite") == "a = ? AND b = ?"
