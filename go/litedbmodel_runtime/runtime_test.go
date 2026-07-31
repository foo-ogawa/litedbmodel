package litedbmodel_runtime

import (
	"testing"

	bc "github.com/foo-ogawa/behavior-contracts/go"
	conf "github.com/foo-ogawa/litedbmodel/go/conformance"
)

// ── render-layer placeholder resolution (the leaf transport's `?`→`$N` step) ────

func TestRenderPlaceholdersQuoteAware(t *testing.T) {
	if got := renderPlaceholders("SELECT '?' AS q WHERE a = ?", "postgres"); got != "SELECT '?' AS q WHERE a = $1" {
		t.Errorf("quote-aware PG: got %q", got)
	}
	if got := renderPlaceholders("a = ? AND b = ?", "sqlite"); got != "a = ? AND b = ?" {
		t.Errorf("sqlite untouched: got %q", got)
	}
}

// ── dialect strategy table (dialect.go) ────────────────────────────────────────

func TestMysqlOrderByNullsEmulation(t *testing.T) {
	my, _ := DialectFor("mysql")
	if got := my.OrderByNulls("created_at", "DESC", "LAST"); got != "created_at IS NULL ASC, created_at DESC" {
		t.Errorf("mysql NULLS LAST: got %q", got)
	}
	if got := my.OrderByNulls("created_at", "ASC", "FIRST"); got != "created_at IS NULL DESC, created_at ASC" {
		t.Errorf("mysql NULLS FIRST: got %q", got)
	}
}

func TestUnknownDialectFailsClosed(t *testing.T) {
	if _, err := DialectFor("oracle"); err == nil {
		t.Errorf("unknown dialect must fail closed")
	}
}

// ── conformance value codec round-trip ────────────────────────────────────────

func TestConformanceCodec(t *testing.T) {
	if got := conf.EncodeConformanceJSON(int64(5)); got != `{"$bigint":"5"}` {
		t.Errorf("int64 encode: got %s", got)
	}
	if got := conf.EncodeConformanceJSON(float64(7)); got != `7` {
		t.Errorf("whole float encode: got %s", got)
	}
	n, _ := bc.ParseJSONOrdered([]byte(`{"$bigint":"4"}`))
	v, _ := conf.DecodeConformanceValue(n)
	if v != int64(4) {
		t.Errorf("$bigint decode: got %T %v", v, v)
	}
	n2, _ := bc.ParseJSONOrdered([]byte(`7`))
	v2, _ := conf.DecodeConformanceValue(n2)
	if v2 != float64(7) {
		t.Errorf("bare-int decode: got %T %v", v2, v2)
	}
}
