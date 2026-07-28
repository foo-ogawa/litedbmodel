package setup

import (
	"fmt"
	"os"
)

// The live-DB connection targets for the ORM-bench cells (#156/#157) — the SAME dockerized Postgres 16
// (:5433) and MySQL 8 (:3307) the conformance live legs use, from the same TEST_* environment.
//
// Both go cells need these, and neither may own them: the native cell opens through
// litedbmodel_runtime's OpenPostgres/OpenMysql (the runtime owns connections), while the SDK cell must
// reach the plain driver directly — #157 invariant 6 puts the runtime and the generated modules out of
// its path, and the runtime's MySQL opener installs a RETURNING-emulating driver wrapper the raw
// baseline must not inherit. So the DSN STRINGS live here, in the package that already declares itself
// the shared loader for both cells, and each cell opens them its own way.

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// PostgresDSN builds the pgx-stdlib / libpq URL for the bench Postgres.
func PostgresDSN() string {
	return fmt.Sprintf("postgres://%s:%s@%s:%s/%s?sslmode=disable",
		envOr("TEST_DB_USER", "testuser"), envOr("TEST_DB_PASSWORD", "testpass"),
		envOr("TEST_DB_HOST", "localhost"), envOr("TEST_DB_PORT", "5433"),
		envOr("TEST_DB_NAME", "testdb"))
}

// MysqlDSN builds the go-sql-driver DSN for the bench MySQL. `parseTime` is off: the cells decode
// DATETIME as the driver's raw bytes, matching what the other languages' cells hold.
func MysqlDSN() string {
	return fmt.Sprintf("%s:%s@tcp(%s:%s)/%s?multiStatements=false",
		envOr("TEST_MYSQL_USER", "testuser"), envOr("TEST_MYSQL_PASSWORD", "testpass"),
		envOr("TEST_MYSQL_HOST", "127.0.0.1"), envOr("TEST_MYSQL_PORT", "3307"),
		envOr("TEST_MYSQL_DB", "testdb"))
}
