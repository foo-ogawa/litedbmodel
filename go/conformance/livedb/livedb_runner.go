// litedbmodel SCP LIVE-DB conformance — the Go leg (#36 WS7g; leaf/emitter cutover #144, #163).
//
// What runs here is the module bc GENERATED for this language from the SAME declaration the TS leg
// runs (conformance/harness.ts → emitBehaviorModule → `bc generate --lang go-typed-native`, one module
// per live dialect, written by conformance/gen-livedb.ts). Nothing is replayed from a serialized
// bundle: a leaf-executed module needs a LIVE in-process handle, which is why the recorder-era
// bundle-replay model is gone.
//
// The ONLY hand-wiring is the two things that make the generated module callable: BIND the op-agnostic
// leaf transport to a live *sql.DB (litedbmodel_runtime.BindLeafTransport) and CALL the endpoint by its
// SIGNATURE. The dispatch below is the sanctioned conformance-runner switch (CLAUDE.md §3.1) — a plain
// signature-direct call table on vector.entry, not a per-endpoint hand-written exec seam.
//
// Every vector is compared against what the TS leg observed on the SAME server for the SAME dialect
// (conformance/vectors-livedb/livedb.json): the ORDERED statements the leaf handed the driver (captured
// at the runtime's SQL seam via a middleware — the SAME seam the python/php taps use), the FULL nested
// typed result (relation children and their field VALUES included — a row count is not a check, #150),
// and the resulting DB state for a write.
//
// REAL DBs, no mock, NO silent skip: if PG or MySQL is unreachable this ERRORS OUT LOUDLY (exit 3).
// Emits the machine-readable JSON summary the orchestrator expects as its LAST stdout line:
//
//	{"lang":"go-livedb","suites":{"livedb-pg":{..},"livedb-mysql":{..}},"total_pass",...}
//
// Exit: 0 all pass, 1 any fail, 2 corpus-version mismatch, 3 DB unreachable.
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"sort"
	"strconv"
	"strings"

	rt "github.com/foo-ogawa/litedbmodel/go/v3/litedbmodel_runtime"

	my "github.com/foo-ogawa/litedbmodel/go/v3/conformance/gen/mysql"
	pg "github.com/foo-ogawa/litedbmodel/go/v3/conformance/gen/postgres"
)

// SupportedCorpusVersion is the corpus schema version this leg supports (harness.CORPUS_VERSION —
// fail-closed on a mismatch, exactly as the python/php legs do).
const SupportedCorpusVersion = 5

// ── corpus shapes (the pure-JSON corpus; runner-side decode, values folded at compare) ─────────────

type corpusT struct {
	CorpusVersion int      `json:"corpusVersion"`
	Schema        []string `json:"schema"`
	Vectors       []vecT   `json:"vectors"`
}

type vecT struct {
	Name               string         `json:"name"`
	Dialect            string         `json:"dialect"`
	Entry              string         `json:"entry"`
	Input              map[string]any `json:"input"`
	ExpectedStatements []stmtT        `json:"expectedStatements"`
	ExpectedResult     any            `json:"expectedResult"`
	ExpectedDbState    []stateT       `json:"expectedDbState"`
}

type stmtT struct {
	Sql    string `json:"sql"`
	Params []any  `json:"params"`
}

type stateT struct {
	Query string `json:"query"`
	Rows  any    `json:"rows"`
}

// ── canonical comparison ───────────────────────────────────────────────────────────────────────────
//
// Two NUMERIC REPRESENTATIONS of one declared type are folded, and nothing else — a differing VALUE
// still compares unequal (the SAME rule as the python `_canon` / php `canonical`):
//   - {"$bigint":"N"} (how the TS reference encodes a bc `int` cell for JSON) folds to the integer N;
//   - an INTEGRAL float (a JS `number` for an int32 column, or a driver-scanned INTEGER cell) folds to
//     the integer it denotes. 10.5 still differs from 10.
// Object keys are sorted so key ORDER never enters the comparison (the generated struct fields are
// alpha-ordered; the corpus rows are DB-column-ordered — canon removes the difference).

func canon(v any) string {
	switch t := v.(type) {
	case nil:
		return "null"
	case bool:
		if t {
			return "true"
		}
		return "false"
	case string:
		return strconv.Quote(t)
	case int64:
		return strconv.FormatInt(t, 10)
	case int:
		return strconv.Itoa(t)
	case float64:
		if t == float64(int64(t)) {
			return strconv.FormatInt(int64(t), 10)
		}
		return strconv.FormatFloat(t, 'g', -1, 64)
	case json.Number:
		if i, err := t.Int64(); err == nil {
			return strconv.FormatInt(i, 10)
		}
		return t.String()
	case []any:
		parts := make([]string, len(t))
		for i, e := range t {
			parts[i] = canon(e)
		}
		return "[" + strings.Join(parts, ",") + "]"
	case map[string]any:
		// The bigint tag folds to its integer (the ONLY single-key object that is not a real record).
		if s, ok := t["$bigint"].(string); ok && len(t) == 1 {
			return s
		}
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		parts := make([]string, len(keys))
		for i, k := range keys {
			parts[i] = strconv.Quote(k) + ":" + canon(t[k])
		}
		return "{" + strings.Join(parts, ",") + "}"
	default:
		return fmt.Sprintf("<?%T>", v)
	}
}

// reflectToAny lowers a bc-generated typed result (structs of *float64 / *string / int64 / nested
// slices + pointers) into the plain `any` tree canon compares. A struct field's WIRE KEY is its Go
// field name with the first letter lowercased — bc capitalizes the wire key's first letter to make the
// field exported, so the inverse recovers it (Author_id → author_id, Id → id, LastInsertRowid →
// lastInsertRowid). No column of this corpus needs any other transform.
func reflectToAny(rv reflect.Value) any {
	switch rv.Kind() {
	case reflect.Interface, reflect.Ptr:
		if rv.IsNil() {
			return nil
		}
		return reflectToAny(rv.Elem())
	case reflect.Slice, reflect.Array:
		out := make([]any, rv.Len())
		for i := 0; i < rv.Len(); i++ {
			out[i] = reflectToAny(rv.Index(i))
		}
		return out
	case reflect.Struct:
		m := make(map[string]any, rv.NumField())
		t := rv.Type()
		for i := 0; i < t.NumField(); i++ {
			m[lowerFirst(t.Field(i).Name)] = reflectToAny(rv.Field(i))
		}
		return m
	case reflect.String:
		return rv.String()
	case reflect.Bool:
		return rv.Bool()
	case reflect.Float32, reflect.Float64:
		return rv.Float()
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return rv.Int()
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return int64(rv.Uint())
	default:
		return nil
	}
}

func lowerFirst(s string) string {
	if s == "" {
		return s
	}
	return strings.ToLower(s[:1]) + s[1:]
}

// bcToAny lowers a runtime read result (bc.Value rows: *bc.Obj + float64/string/bool/nil) into the
// plain `any` tree — used for the post-write DB-state assertion, which reads through the runtime seam.
func bcToAny(v any) any {
	switch t := v.(type) {
	case nil, bool, string, float64, int64:
		return t
	case []any:
		out := make([]any, len(t))
		for i, e := range t {
			out[i] = bcToAny(e)
		}
		return out
	default:
		rv := reflect.ValueOf(v)
		// *bc.Obj is an ordered map (exported Keys []string + Vals map[string]Value); read it via
		// reflection so the runner needs no compile dependency on bc's Obj internals.
		if rv.Kind() == reflect.Ptr && !rv.IsNil() {
			rv = rv.Elem()
		}
		if rv.Kind() == reflect.Struct {
			keysF := rv.FieldByName("Keys")
			valsF := rv.FieldByName("Vals")
			if keysF.IsValid() && valsF.IsValid() && keysF.Kind() == reflect.Slice {
				m := make(map[string]any, keysF.Len())
				for i := 0; i < keysF.Len(); i++ {
					k := keysF.Index(i).String()
					m[k] = bcToAny(valsF.MapIndex(reflect.ValueOf(k)).Interface())
				}
				return m
			}
		}
		if rv.Kind() == reflect.Slice {
			out := make([]any, rv.Len())
			for i := 0; i < rv.Len(); i++ {
				out[i] = bcToAny(rv.Index(i).Interface())
			}
			return out
		}
		return v
	}
}

// ── input decode (corpus JSON → the entry's positional native args) ────────────────────────────────

func i64(m map[string]any, k string) int64 {
	f, _ := m[k].(float64)
	return int64(f)
}

func str(m map[string]any, k string) string {
	s, _ := m[k].(string)
	return s
}

// optStr maps an optional predicate input (Feed's `status` / `since`) to a *string — nil when the key
// is absent (the SKIP-drop case) or JSON null.
func optStr(m map[string]any, k string) *string {
	v, ok := m[k]
	if !ok || v == nil {
		return nil
	}
	s, _ := v.(string)
	return &s
}

// optI64 is the INT twin of optStr (PagedFeed's `minId` cursor) — nil on an absent / null key.
func optI64(m map[string]any, k string) *int64 {
	v, ok := m[k]
	if !ok || v == nil {
		return nil
	}
	f, _ := v.(float64)
	n := int64(f)
	return &n
}

func i64s(m map[string]any, k string) []int64 {
	arr, _ := m[k].([]any)
	out := make([]int64, len(arr))
	for i, e := range arr {
		f, _ := e.(float64)
		out[i] = int64(f)
	}
	return out
}

func strs(m map[string]any, k string) []string {
	arr, _ := m[k].([]any)
	out := make([]string, len(arr))
	for i, e := range arr {
		out[i], _ = e.(string)
	}
	return out
}

func records(m map[string]any) []map[string]any {
	arr, _ := m["rows"].([]any)
	out := make([]map[string]any, len(arr))
	for i, e := range arr {
		out[i], _ = e.(map[string]any)
	}
	return out
}

// entryFn is one endpoint of the dispatch TABLE below: the dialect flag and the vector's input,
// returning what the generated method returned. Every body is a signature-direct call on the
// dialect's generated package (CLAUDE.md §3.1) — the table only decides WHICH one runs.
type entryFn func(postgres bool, in map[string]any) (any, error)

// dispatch is the conformance runner's endpoint table — the sanctioned harness form (CLAUDE.md §3,
// the same shape python/php already have with `ops[vector["entry"]]`). It is a TABLE and not a
// `switch` for one reason: the set of entries this runner can dispatch is then a VALUE, so
// `missingEntries` can assert the corpus is covered before a single query runs. A `switch` ends in
// a catch-all, so a missed endpoint compiled and surfaced only as a failing vector on a live
// database — and the static scanner that used to look for it was fooled twice by comment and
// string syntax it did not model (#201, #222).
//
// The batch endpoints bind a per-dialect input shape (PG columnar arrays vs MySQL/SQLite one record
// array), so those bodies branch on `postgres`.
var dispatch = map[string]entryFn{
	"posts": func(postgres bool, in map[string]any) (any, error) {
		if postgres {
			return pg.Posts(i64(in, "authorId"))
		}
		return my.Posts(i64(in, "authorId"))
	},
	"postsTop": func(postgres bool, in map[string]any) (any, error) {
		if postgres {
			return pg.PostsTop()
		}
		return my.PostsTop()
	},
	"page": func(postgres bool, in map[string]any) (any, error) {
		if postgres {
			return pg.Page(i64(in, "limit"), i64(in, "offset"))
		}
		return my.Page(i64(in, "limit"), i64(in, "offset"))
	},
	"postsByIds": func(postgres bool, in map[string]any) (any, error) {
		if postgres {
			return pg.PostsByIds(i64s(in, "ids"))
		}
		return my.PostsByIds(i64s(in, "ids"))
	},
	"feed": func(postgres bool, in map[string]any) (any, error) {
		if postgres {
			return pg.Feed(i64(in, "authorId"), optStr(in, "status"), optStr(in, "since"))
		}
		return my.Feed(i64(in, "authorId"), optStr(in, "status"), optStr(in, "since"))
	},
	"pagedFeed": func(postgres bool, in map[string]any) (any, error) {
		if postgres {
			return pg.PagedFeed(i64(in, "authorId"), optI64(in, "minId"), optStr(in, "status"), i64(in, "limit"), i64(in, "offset"))
		}
		return my.PagedFeed(i64(in, "authorId"), optI64(in, "minId"), optStr(in, "status"), i64(in, "limit"), i64(in, "offset"))
	},
	"optionalOnlyFeed": func(postgres bool, in map[string]any) (any, error) {
		if postgres {
			return pg.OptionalOnlyFeed(optI64(in, "authorId"), optStr(in, "status"))
		}
		return my.OptionalOnlyFeed(optI64(in, "authorId"), optStr(in, "status"))
	},
	"quotedOrderFeed": func(postgres bool, in map[string]any) (any, error) {
		if postgres {
			return pg.QuotedOrderFeed(i64(in, "authorId"), optI64(in, "minId"), i64(in, "limit"))
		}
		return my.QuotedOrderFeed(i64(in, "authorId"), optI64(in, "minId"), i64(in, "limit"))
	},
	"quotedWhereOrderFeed": func(postgres bool, in map[string]any) (any, error) {
		if postgres {
			return pg.QuotedWhereOrderFeed(optStr(in, "status"))
		}
		return my.QuotedWhereOrderFeed(optStr(in, "status"))
	},
	"viewFeed": func(postgres bool, in map[string]any) (any, error) {
		if postgres {
			return pg.ViewFeed(optStr(in, "status"))
		}
		return my.ViewFeed(optStr(in, "status"))
	},
	"usersWithPosts": func(postgres bool, in map[string]any) (any, error) {
		if postgres {
			return pg.UsersWithPosts()
		}
		return my.UsersWithPosts()
	},
	"postsWithAuthor": func(postgres bool, in map[string]any) (any, error) {
		if postgres {
			return pg.PostsWithAuthor()
		}
		return my.PostsWithAuthor()
	},
	"createPost": func(postgres bool, in map[string]any) (any, error) {
		if postgres {
			return pg.CreatePost(i64(in, "id"), i64(in, "authorId"), str(in, "title"), str(in, "status"), str(in, "createdAt"))
		}
		return my.CreatePost(i64(in, "id"), i64(in, "authorId"), str(in, "title"), str(in, "status"), str(in, "createdAt"))
	},
	"renamePost": func(postgres bool, in map[string]any) (any, error) {
		if postgres {
			return pg.RenamePost(str(in, "title"), i64(in, "id"))
		}
		return my.RenamePost(str(in, "title"), i64(in, "id"))
	},
	"removePost": func(postgres bool, in map[string]any) (any, error) {
		if postgres {
			return pg.RemovePost(i64(in, "id"))
		}
		return my.RemovePost(i64(in, "id"))
	},
	"createPostReturning": func(postgres bool, in map[string]any) (any, error) {
		if postgres {
			return pg.CreatePostReturning(i64(in, "id"), i64(in, "authorId"), str(in, "title"), str(in, "status"), str(in, "createdAt"))
		}
		return my.CreatePostReturning(i64(in, "id"), i64(in, "authorId"), str(in, "title"), str(in, "status"), str(in, "createdAt"))
	},
	"renamePostReturning": func(postgres bool, in map[string]any) (any, error) {
		if postgres {
			return pg.RenamePostReturning(str(in, "title"), i64(in, "id"))
		}
		return my.RenamePostReturning(str(in, "title"), i64(in, "id"))
	},
	"removePostReturning": func(postgres bool, in map[string]any) (any, error) {
		if postgres {
			return pg.RemovePostReturning(i64(in, "id"))
		}
		return my.RemovePostReturning(i64(in, "id"))
	},
	"createDoc": func(postgres bool, in map[string]any) (any, error) {
		if postgres {
			return pg.CreateDoc(str(in, "docId"), str(in, "title"))
		}
		return my.CreateDoc(str(in, "docId"), str(in, "title"))
	},
	"createLine": func(postgres bool, in map[string]any) (any, error) {
		if postgres {
			return pg.CreateLine(i64(in, "orderId"), i64(in, "lineNo"), str(in, "sku"))
		}
		return my.CreateLine(i64(in, "orderId"), i64(in, "lineNo"), str(in, "sku"))
	},
	"restatusPostsReturning": func(postgres bool, in map[string]any) (any, error) {
		if postgres {
			return pg.RestatusPostsReturning(str(in, "status"), i64(in, "authorId"))
		}
		return my.RestatusPostsReturning(str(in, "status"), i64(in, "authorId"))
	},
	"removePostsByAuthorReturning": func(postgres bool, in map[string]any) (any, error) {
		if postgres {
			return pg.RemovePostsByAuthorReturning(i64(in, "authorId"))
		}
		return my.RemovePostsByAuthorReturning(i64(in, "authorId"))
	},
	"typedRows": func(postgres bool, in map[string]any) (any, error) {
		if postgres {
			return pg.TypedRows()
		}
		return my.TypedRows()
	},
	"removeTags": func(postgres bool, in map[string]any) (any, error) {
		if postgres {
			return pg.RemoveTags(i64s(in, "ids"))
		}
		return my.RemoveTags(i64s(in, "ids"))
	},
	"removeTagsReturning": func(postgres bool, in map[string]any) (any, error) {
		if postgres {
			return pg.RemoveTagsReturning(i64s(in, "ids"))
		}
		return my.RemoveTagsReturning(i64s(in, "ids"))
	},
	"createTags": func(postgres bool, in map[string]any) (any, error) {
		if postgres {
			return pg.CreateTags(i64s(in, "rows_id"), i64s(in, "rows_post_id"), strs(in, "rows_label"))
		}
		rows := make([]my.CreateTagsRecord, 0)
		for _, r := range records(in) {
			rows = append(rows, my.CreateTagsRecord{Id: i64(r, "id"), Post_id: i64(r, "post_id"), Label: str(r, "label")})
		}
		return my.CreateTags(rows)
	},
	"createTagsReturning": func(postgres bool, in map[string]any) (any, error) {
		if postgres {
			return pg.CreateTagsReturning(i64s(in, "rows_id"), i64s(in, "rows_post_id"), strs(in, "rows_label"))
		}
		rows := make([]my.CreateTagsReturningRecord, 0)
		for _, r := range records(in) {
			rows = append(rows, my.CreateTagsReturningRecord{Id: i64(r, "id"), Post_id: i64(r, "post_id"), Label: str(r, "label")})
		}
		return my.CreateTagsReturning(rows)
	},
	"relabelTagsReturning": func(postgres bool, in map[string]any) (any, error) {
		if postgres {
			return pg.RelabelTagsReturning(i64s(in, "rows_id"), strs(in, "rows_label"))
		}
		rows := make([]my.RelabelTagsReturningRecord, 0)
		for _, r := range records(in) {
			rows = append(rows, my.RelabelTagsReturningRecord{Id: i64(r, "id"), Label: str(r, "label")})
		}
		return my.RelabelTagsReturning(rows)
	},
}

// callEntry runs one vector's endpoint. The catch-all is kept as a runtime guard, but it is no
// longer the only thing standing between a missed endpoint and a live-DB failure: main asserts
// coverage from the same table before connecting.
func callEntry(dialect, entry string, in map[string]any) (any, error) {
	fn, ok := dispatch[entry]
	if !ok {
		return nil, fmt.Errorf("unknown entry %q", entry)
	}
	return fn(dialect == "postgres", in)
}

// gap is one corpus entry the dispatch table cannot serve, with how many vectors would have failed.
type gap struct {
	entry   string
	vectors int
}

// entryCoverage compares the corpus against `dispatch`: how many DISTINCT entries it uses, and which
// of them have no arm. One walk, and the only place that comparison is made — main asserts it before
// connecting, and `--check-coverage` reports it as a gate.
func entryCoverage(corpus corpusT) (used int, missing []gap) {
	counts := map[string]int{}
	order := []string{}
	for _, v := range corpus.Vectors {
		if _, seen := counts[v.Entry]; !seen {
			order = append(order, v.Entry)
		}
		counts[v.Entry]++
	}
	sort.Strings(order)
	for _, e := range order {
		if _, ok := dispatch[e]; !ok {
			missing = append(missing, gap{entry: e, vectors: counts[e]})
		}
	}
	return len(order), missing
}

// ── statement TAP: the SQL the leaf transport handed the driver, at the runtime SQL seam ───────────
//
// A middleware on the runtime's OWN execute/run seam — the SAME layer the python `_TapDriver` and php
// middleware tap. What it records is the exact driver-bound form: the dynamic (SKIP) WHERE already
// assembled, `?`→`$N` already rendered and the array params already encoded. Schema + DB-state queries
// run OFF this seam (raw *sql.DB / a snapshot taken before), so a vector's log is only its own ops.

var stmtLog []stmtT

func recordStmt(sqlText string, args []any) {
	// Copy the args into the plain-JSON tree canon compares (encode/no-encode is folded there).
	params := make([]any, len(args))
	for i, a := range args {
		params[i] = argToAny(a)
	}
	stmtLog = append(stmtLog, stmtT{Sql: sqlText, Params: params})
}

// argToAny lowers ONE driver-bound arg into the plain tree. A PG array param binds as a Go []any
// (native array); every other dialect binds a scalar or a JSON-string array. Nested arrays recurse.
func argToAny(a any) any {
	switch t := a.(type) {
	case nil, bool, string, float64, int64, int:
		return t
	case []any:
		out := make([]any, len(t))
		for i, e := range t {
			out[i] = argToAny(e)
		}
		return out
	default:
		rv := reflect.ValueOf(a)
		if rv.Kind() == reflect.Slice {
			out := make([]any, rv.Len())
			for i := 0; i < rv.Len(); i++ {
				out[i] = argToAny(rv.Index(i).Interface())
			}
			return out
		}
		switch rv.Kind() {
		case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
			return rv.Int()
		case reflect.Float32, reflect.Float64:
			return rv.Float()
		}
		return a
	}
}

// ── one leg ────────────────────────────────────────────────────────────────────────────────────────

type tally struct {
	Pass int `json:"pass"`
	Fail int `json:"fail"`
}

func runVector(db *sql.DB, ctx *rt.ExecutionContext, v vecT) (bool, string) {
	stmtLog = nil
	result, callErr := callEntry(v.Dialect, v.Entry, v.Input)
	// Snapshot the vector's statements BEFORE any DB-state query (which runs through the same seam).
	got := make([]stmtT, len(stmtLog))
	copy(got, stmtLog)

	var problems []string
	if callErr != nil {
		return false, "threw: " + callErr.Error()
	}
	// Statements.
	gotStmts := stmtsToAny(got)
	wantStmts := stmtsToAny(v.ExpectedStatements)
	if canon(gotStmts) != canon(wantStmts) {
		problems = append(problems, "statements "+canon(gotStmts)+" != "+canon(wantStmts))
	}
	// The FULL typed result (nested children + their values, #150).
	gotRes := reflectToAny(reflect.ValueOf(result))
	if canon(gotRes) != canon(v.ExpectedResult) {
		problems = append(problems, "result "+canon(gotRes)+" != "+canon(v.ExpectedResult))
	}
	// DB state after a write, read through the runtime seam (typed rows).
	for _, s := range v.ExpectedDbState {
		rows, err := rt.Execute(ctx, s.Query, nil, rt.ReadIntent())
		if err != nil {
			problems = append(problems, fmt.Sprintf("db-state '%s' query error: %v", s.Query, err))
			continue
		}
		// bcToAny lowers the []bc.Value rows via reflection (its slice branch), so the []bc.Value the
		// seam returns needs no separate []any copy — pass it straight through.
		gotRows := bcToAny(rows)
		if canon(gotRows) != canon(s.Rows) {
			problems = append(problems, fmt.Sprintf("db-state '%s': %s != %s", s.Query, canon(gotRows), canon(s.Rows)))
		}
	}
	return len(problems) == 0, strings.Join(problems, "; ")
}

func stmtsToAny(ss []stmtT) any {
	out := make([]any, len(ss))
	for i, s := range ss {
		params := make([]any, len(s.Params))
		for j, p := range s.Params {
			params[j] = normalizeJSONParam(p)
		}
		out[i] = map[string]any{"sql": s.Sql, "params": params}
	}
	return out
}

// normalizeJSONParam parses a param that is a JSON-DOCUMENT string (a `?`-bound json_each / JSON_TABLE
// payload — the batch-record and IN-list array param MySQL binds as ONE JSON text) into its structural
// value, so canon compares it by CONTENT with its object keys sorted — exactly as canon already
// compares every result/db-state object. It runs on BOTH the observed and the expected side (both flow
// through this function), so it never changes WHICH statements match; it only stops a param's JSON key
// ORDER from mattering. The bc typed-native emitter serializes a record's wire keys ALPHABETICALLY
// (id,label,post_id) whereas the TS/py/php reference the corpus was captured from keeps DECLARATION
// order (id,post_id,label); the JSON object those two produce is the SAME logical param (JSON_TABLE
// extracts by `$.name`, never by position), so a byte compare of the serialization would flag a
// non-contract detail. A wrong value, a missing/extra key, or a non-JSON param still fails (only order
// is neutralized). A scalar param (number/plain string) is left untouched.
func normalizeJSONParam(p any) any {
	s, ok := p.(string)
	if !ok {
		return p
	}
	t := strings.TrimSpace(s)
	if t == "" || (t[0] != '[' && t[0] != '{') {
		return p
	}
	var parsed any
	if err := json.Unmarshal([]byte(s), &parsed); err != nil {
		return p
	}
	return parsed
}

func runLeg(dialect string, db *sql.DB, corpus corpusT) tally {
	t := tally{}
	var vectors []vecT
	for _, v := range corpus.Vectors {
		if v.Dialect == dialect {
			vectors = append(vectors, v)
		}
	}
	fmt.Fprintf(os.Stderr, "\nlivedb-%s — %d vectors (real %s)\n", dialect, len(vectors), dialect)
	ctx := rt.ContextForDB(db)
	rt.BindLeafTransport(ctx, dialect)
	defer rt.UnbindLeafTransport()
	for _, v := range vectors {
		// Every vector starts from the SAME seeded state the TS leg captured from (raw, OFF the seam).
		if err := applySchema(db, corpus.Schema); err != nil {
			t.Fail++
			fmt.Fprintf(os.Stderr, "  XX  %s\n      seed: %v\n", v.Name, err)
			continue
		}
		ok, detail := runVector(db, ctx, v)
		if ok {
			t.Pass++
			fmt.Fprintf(os.Stderr, "  ok  %s\n", v.Name)
		} else {
			t.Fail++
			fmt.Fprintf(os.Stderr, "  XX  %s\n      %s\n", v.Name, detail)
		}
	}
	return t
}

func applySchema(db *sql.DB, schema []string) error {
	for _, s := range schema {
		if _, err := db.Exec(s); err != nil {
			return fmt.Errorf("%q: %w", s, err)
		}
	}
	return nil
}

// ── main ───────────────────────────────────────────────────────────────────────────────────────────

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func pgDSN() string {
	return fmt.Sprintf("postgres://%s:%s@%s:%s/%s?sslmode=disable",
		envOr("TEST_DB_USER", "testuser"), envOr("TEST_DB_PASSWORD", "testpass"),
		envOr("TEST_DB_HOST", "localhost"), envOr("TEST_DB_PORT", "5433"),
		envOr("TEST_DB_NAME", "testdb"))
}

func mysqlDSN() string {
	return fmt.Sprintf("%s:%s@tcp(%s:%s)/%s?multiStatements=false",
		envOr("TEST_MYSQL_USER", "testuser"), envOr("TEST_MYSQL_PASSWORD", "testpass"),
		envOr("TEST_MYSQL_HOST", "127.0.0.1"), envOr("TEST_MYSQL_PORT", "3307"),
		envOr("TEST_MYSQL_DB", "testdb"))
}

func printSummary(suites map[string]tally, totalPass, totalFail int, versionMismatch bool) {
	out, _ := json.Marshal(map[string]any{
		"lang":             "go-livedb",
		"suites":           suites,
		"total_pass":       totalPass,
		"total_fail":       totalFail,
		"version_mismatch": versionMismatch,
	})
	fmt.Println(string(out))
}

func main() {
	fmt.Fprintln(os.Stderr, "litedbmodel SCP LIVE-DB conformance — Go runner (bc-generated modules, real PG + MySQL)")

	corpusPath := envOr("LITEDBMODEL_LIVEDB_VECTORS", "")
	if corpusPath == "" {
		fmt.Fprintln(os.Stderr, "FATAL: LITEDBMODEL_LIVEDB_VECTORS is not set")
		os.Exit(2)
	}
	data, err := os.ReadFile(corpusPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: cannot read corpus %s: %v\n", corpusPath, err)
		os.Exit(2)
	}
	var corpus corpusT
	if err := json.Unmarshal(data, &corpus); err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: cannot parse corpus: %v\n", err)
		os.Exit(2)
	}
	if corpus.CorpusVersion != SupportedCorpusVersion {
		fmt.Fprintf(os.Stderr, "FAIL-CLOSED: corpusVersion %d != %d\n", corpus.CorpusVersion, SupportedCorpusVersion)
		printSummary(map[string]tally{}, 0, 0, true)
		os.Exit(2)
	}

	// Every entry the corpus uses has an arm — asserted HERE, with the corpus parsed and no database
	// touched yet, which is the only point where the question is both answerable and free. An endpoint
	// added to conformance/harness.ts needs a new arm in `dispatch`; without this the miss reached
	// `callEntry`'s catch-all and surfaced as a failing VECTOR, after docker was up and the other three
	// language legs had run. `--check-coverage` stops here, so the same assertion is a gate that needs
	// no server (#222).
	used, missing := entryCoverage(corpus)
	checkOnly := len(os.Args) > 1 && os.Args[1] == "--check-coverage"
	if len(missing) > 0 {
		fmt.Fprintf(os.Stderr, "FAIL-CLOSED: %d of the %d entries this corpus uses have NO arm in the dispatch table:\n", len(missing), used)
		for _, m := range missing {
			fmt.Fprintf(os.Stderr, "    %s   (%d vector(s))\n", m.entry, m.vectors)
		}
		fmt.Fprintln(os.Stderr, "Add each to `dispatch` in go/conformance/livedb/livedb_runner.go.")
		if !checkOnly {
			printSummary(map[string]tally{}, 0, 0, true)
		}
		os.Exit(2)
	}
	if checkOnly {
		fmt.Printf("✅ go livedb runner: every one of the %d entries the %d-vector corpus uses has an arm in the dispatch table (%d arms declared)\n",
			used, len(corpus.Vectors), len(dispatch))
		return
	}

	pgdb, err := rt.OpenPostgres(pgDSN())
	if err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: Postgres unreachable — %v\n", err)
		os.Exit(3)
	}
	defer pgdb.Close()
	mydb, err := rt.OpenMysql(mysqlDSN())
	if err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: MySQL unreachable — %v\n", err)
		os.Exit(3)
	}
	defer mydb.Close()

	// The statement tap is registered once, process-globally (the seam middleware the leaf funnels
	// through). Schema + DB-state run OFF this seam, so a vector's log holds only its own ops.
	mw := rt.NewMiddleware(rt.MiddlewareConfig{
		Execute: func(_ any, next rt.ExecNext, sqlText string, args []any) (any, error) {
			recordStmt(sqlText, args)
			return next(sqlText, args)
		},
	})
	unregister := rt.RegisterMiddleware(context.Background(), mw.Descriptor())
	defer unregister()

	suites := map[string]tally{}
	suites["livedb-pg"] = runLeg("postgres", pgdb, corpus)
	suites["livedb-mysql"] = runLeg("mysql", mydb, corpus)

	totalPass, totalFail := 0, 0
	for _, t := range suites {
		totalPass += t.Pass
		totalFail += t.Fail
	}
	fmt.Fprintf(os.Stderr, "\n%d passed, %d failed / %d live-DB vectors\n", totalPass, totalFail, totalPass+totalFail)
	printSummary(suites, totalPass, totalFail, false)
	if totalFail > 0 {
		os.Exit(1)
	}
}
