// Package litedbmodel_runtime is the Go leg of the litedbmodel v2 SCP multi-language runtime
// (WS7c, #32).
//
// It is the shared, production runtime the BC-generated native modules bind to: the leaf transport
// (leaf_transport.go — executeSQL / pluck / group, the SOLE leaf catalog), the central execution
// seam + middleware (exec_context.go / middleware.go), connection routing / reader-writer pool /
// writer-sticky / per-execution tx ownership (connection_routing.go / exec_context.go), de-box +
// grouping (wire / grouping.go), the dialect strategy table (dialect.go) and the render-layer
// placeholder resolution (leaf_transport.go finalizeSQL). Execution is NATIVE: a `bc generate`d
// module drives the closed-set orchestration and calls the leaf handlers directly — there is no
// generic IR interpreter and no litedbmodel-owned bundle/read-graph execution path.

package litedbmodel_runtime

// Version is synced from package.json by scripts/sync-versions.mjs (Go = VCS tag, not a manifest
// field, so this constant is the in-source mirror the CI tag check compares against).
const Version = "2.2.3"
