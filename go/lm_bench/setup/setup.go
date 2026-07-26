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
