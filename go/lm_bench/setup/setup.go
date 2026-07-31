// Package setup loads the ONE cross-lang ORM-bench seed SSoT — benchmark/crosslang/.setup/<dialect>.json,
// emitted from orm-domain.ts by emit-setup.ts — for BOTH go bench cells (lm_orm_native + lm_orm). No go
// cell hand-writes a schema or seed: each applies Doc.Schema once at open and Doc.Delete+Doc.Insert as
// the canonical fixture. This is the single go-side consumer of the JSON artifact.
package setup

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

// Doc is one dialect's setup: Schema (drop+create, applied once) + Delete+Insert (the canonical fixture
// as literal SQL, re-applied per op). Every statement execs with no bound params. Ops carries the
// statements each op issues, captured from the GENERATED module's seam — the SDK baselines execute these
// rather than hand-writing their own SQL, so the two surfaces cannot diverge (#172).
type Doc struct {
	Dialect string              `json:"dialect"`
	Users   int                 `json:"users"`
	Schema  []string            `json:"schema"`
	Delete  []string            `json:"delete"`
	Insert  []string            `json:"insert"`
	Ops     map[string][]string `json:"ops,omitempty"`
	// Inputs is what each op BINDS, from the axis SSoT (benchmark/crosslang/contract.ts). Declared
	// rather than captured — it is what the cells supply — and read here so neither go cell spells a
	// value out: two cells binding different values do different work even on identical SQL, which is
	// precisely what a rows/op check cannot see.
	Inputs map[string]map[string]any `json:"inputs,omitempty"`
	// Recover holds, per op, one entry per statement in Ops: the MySQL RETURNING recovery, or nil
	// where the statement needs none. Absent for PostgreSQL and SQLite. Derived from the captured
	// write by the library's own buildMysqlReselect (benchmark/crosslang/derive-ops.ts →
	// src/scp/makesql/mysql-returning.ts), never hand-copied.
	Recover map[string][]*Recovery `json:"recover,omitempty"`
	// BatchColumns is, per batch-write op, the columns its statement reads. PostgreSQL's UNNEST binds
	// one array PER COLUMN, so the order is the statement's; MySQL and SQLite read one JSON payload by
	// name, so for them it is a set.
	BatchColumns map[string][]string `json:"batchColumns,omitempty"`
}

// Bind says how ONE `?` of a recovering SELECT is bound — the vocabulary of ReselectBind
// (src/scp/makesql/mysql-returning.ts): the write's own param at Index, the first AUTO_INCREMENT id
// the INSERT allocated, or that id plus max(1, affected).
type Bind struct {
	Kind  string `json:"kind"` // "param" | "lastId" | "highId"
	Index int    `json:"index"`
}

// Recovery is one write's MySQL RETURNING recovery: run WriteSQL (the write with the RETURNING clause
// and the /*scp:pk=…*/ hint removed), then fetch SelectSQL bound per Binds. Both together are ONE
// logical statement — what the runtime's seam counts.
type Recovery struct {
	WriteSQL  string `json:"writeSql"`
	SelectSQL string `json:"selectSql"`
	Binds     []Bind `json:"binds"`
}

// Recovery returns the recovery for statement i of op, or nil when the database executes the declared
// RETURNING itself (every PostgreSQL and SQLite statement, and most MySQL ones).
func (d Doc) Recovery(op string, i int) *Recovery {
	rs := d.Recover[op]
	if i >= len(rs) {
		return nil
	}
	return rs[i]
}

// Columns is the batch column list for op — a HARD failure when absent, since binding a batch write
// without the statement's own column order is the guess this removes.
func (d Doc) Columns(op string) []string {
	cols, ok := d.BatchColumns[op]
	if !ok {
		panic(fmt.Sprintf("setup: .setup/%s.json declares no batchColumns for %q", d.Dialect, op))
	}
	return cols
}

// Values is one input scope, or one batch record, with `{it}` resolved.
type Values map[string]any

// Input is op's declared input scope for iteration it, with `{it}` — the ONE substitution the artifact
// carries — replaced throughout, so an op with a UNIQUE column stays insertable across a timed loop.
func (d Doc) Input(op string, it int) Values {
	declared, ok := d.Inputs[op]
	if !ok {
		panic(fmt.Sprintf("setup: .setup/%s.json declares no inputs for %q", d.Dialect, op))
	}
	out := make(Values, len(declared))
	for name, value := range declared {
		out[name] = resolveIt(value, strconv.Itoa(it))
	}
	return out
}

// resolveIt substitutes `{it}` in every string of a decoded input value.
func resolveIt(value any, it string) any {
	switch v := value.(type) {
	case string:
		return strings.ReplaceAll(v, "{it}", it)
	case []any:
		out := make([]any, len(v))
		for i, e := range v {
			out[i] = resolveIt(e, it)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(v))
		for k, e := range v {
			out[k] = resolveIt(e, it)
		}
		return out
	default:
		return value
	}
}

// Str is the named input as a string; absent or of another type is a HARD failure — a bench that binds
// a zero value reports a number for work nobody asked for.
func (v Values) Str(name string) string {
	s, ok := v[name].(string)
	if !ok {
		panic(fmt.Sprintf("setup: input %q is %T, want string", name, v[name]))
	}
	return s
}

// Int is the named input as an int64. JSON decodes every number to float64, so this is the one place
// that conversion happens on the go side.
func (v Values) Int(name string) int64 {
	f, ok := v[name].(float64)
	if !ok {
		panic(fmt.Sprintf("setup: input %q is %T, want number", name, v[name]))
	}
	return int64(f)
}

// Records is the named input as a batch write's record set.
func (v Values) Records(name string) []Values {
	list, ok := v[name].([]any)
	if !ok {
		panic(fmt.Sprintf("setup: input %q is %T, want an array of records", name, v[name]))
	}
	out := make([]Values, len(list))
	for i, e := range list {
		r, ok := e.(map[string]any)
		if !ok {
			panic(fmt.Sprintf("setup: input %q[%d] is %T, want a record", name, i, e))
		}
		out[i] = Values(r)
	}
	return out
}

// WriteOps merges the captured per-op statement lists into .setup/<dialect>.json, preserving every other
// field verbatim (the file is the ONE artifact every language reads).
func WriteOps(dialect string, ops map[string][]string) error {
	path, err := Path(dialect)
	if err != nil {
		return err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read seed SSoT %s: %w", path, err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return fmt.Errorf("parse %s: %w", path, err)
	}
	doc["ops"] = ops
	out, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(out, '\n'), 0o644)
}

// Path is the ONE place .setup/<dialect>.json is spelled on the go side (repo-root-anchored,
// cwd-independent), shared by the reader and the op-SQL capture that writes back to it.
func Path(dialect string) (string, error) {
	_, self, _, ok := runtime.Caller(0)
	if !ok {
		return "", fmt.Errorf("cannot locate setup package source")
	}
	// self = <repo>/go/lm_bench/setup/setup.go → repo root is three dirs up from the package dir.
	root := filepath.Join(filepath.Dir(self), "..", "..", "..")
	return filepath.Join(root, "benchmark", "crosslang", ".setup", dialect+".json"), nil
}

// Load reads .setup/<dialect>.json.
func Load(dialect string) (Doc, error) {
	path, err := Path(dialect)
	if err != nil {
		return Doc{}, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return Doc{}, fmt.Errorf("read seed SSoT %s: %w", path, err)
	}
	var doc Doc
	if err := json.Unmarshal(raw, &doc); err != nil {
		return Doc{}, fmt.Errorf("parse %s: %w", path, err)
	}
	return doc, nil
}
