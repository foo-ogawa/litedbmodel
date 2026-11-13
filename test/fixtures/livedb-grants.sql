-- WS7g (#36) — create + grant the per-language namespaced databases for the live-DB pass.
--
-- The coordinated live-DB pass isolates each language runtime in its OWN MySQL database
-- (scp_python / scp_go / scp_php / scp_rust) so all four share ONE docker stack without table
-- cross-contamination. The per-language suites connect straight to their database and DDL their
-- tables — they do NOT `CREATE DATABASE` — so the databases must exist first. The base init user
-- (testuser) only owns `testdb`; this creates the scp_% family (as root) and grants testuser ALL on
-- it. The SSoT for scp_% DB setup: docker-compose.livedb.yml mounts this, and conformance-livedb runs it.
CREATE DATABASE IF NOT EXISTS scp_python;
CREATE DATABASE IF NOT EXISTS scp_go;
CREATE DATABASE IF NOT EXISTS scp_php;
CREATE DATABASE IF NOT EXISTS scp_rust;
GRANT ALL PRIVILEGES ON `scp\_%`.* TO 'testuser'@'%';
FLUSH PRIVILEGES;
-- The MySQL RETURNING race tests (#359, all languages) park a write with a BEFORE INSERT trigger that
-- testuser creates. With binary logging ON — the CI `services:` MySQL; the docker stacks run with
-- --skip-log-bin — a non-SUPER user may not create a trigger unless this is set (error 1419).
SET GLOBAL log_bin_trust_function_creators = 1;
