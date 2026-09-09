//go:build bench_mysql

// The mysql target's generated module, bound to the SAME `op()` switch (#156). The SQL is baked per
// dialect, so each target is its OWN package (bc names it after the declaring class) and the cell
// selects one AT BUILD TIME — a `-tags bench_mysql` binary can only ever run mysql. The aliases below are
// direct function values: the call in `op()` resolves statically, with no lookup at run time.
package main

import g "github.com/foo-ogawa/litedbmodel/go/v2/lm_bench/lm_orm_native/gen/benchmysql"

const benchDialect = "mysql"

type (
	NewUser   = g.NewUser
	UserPatch = g.UserPatch
)

var (
	findAll            = g.FindAll
	filterPaginateSort = g.FilterPaginateSort
	findFirst          = g.FindFirst
	findUnique         = g.FindUnique
	nestedFindAll      = g.NestedFindAll
	nestedFindFirst    = g.NestedFindFirst
	nestedFindUnique   = g.NestedFindUnique
	nestedRelations    = g.NestedRelations
	compositeRelations = g.CompositeRelations
	create             = g.Create
	update             = g.Update
	upsert             = g.Upsert
	createMany         = g.CreateMany
	upsertMany         = g.UpsertMany
	updateMany         = g.UpdateMany
	nestedCreate       = g.NestedCreate
	nestedUpsert       = g.NestedUpsert
	nestedUpdate       = g.NestedUpdate
	delete             = g.Delete
)
