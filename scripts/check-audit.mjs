#!/usr/bin/env node
// Guard: `npm audit --audit-level=moderate`, minus the provisional exceptions the owner approved
// (EXCEPTIONS below; none today).
//
// Why a script and not a bare `npm audit` in ci.yml / release.yml: npm audit has no per-advisory,
// per-path allowlist, and an exception must hold only for one advisory reached through one set of
// packages, and only until a deadline. This is the single place that decides it; ci.yml (Audit) and
// release.yml (audit, before the publish) both call `npm run audit:check`, so a pull request that
// passes here does not stop the release after it merges.
//
// The rule is not weakened anywhere else: the level stays `moderate` (info and low are the only
// severities npm audit itself does not gate on), devDependencies are included (no `--omit=dev`), and
// every finding that is not covered by an EXCEPTIONS entry below fails the run.
//
// Usage: node scripts/check-audit.mjs   (exit 1 on any moderate-or-higher finding not excepted)

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The exceptions — the only list. An entry excepts a finding only when ALL of these hold:
 *   - the advisory's id is `advisory`;
 *   - every path from the vulnerable package up to the project goes through one of `viaPackages`
 *     (npm audit's `effects` — the packages that depend on the vulnerable one — must all be in
 *     `viaPackages`, or in the chain of excepted packages up to them), and the vulnerable package is
 *     not a direct dependency of the project;
 *   - the date (UTC) is before `expires`.
 * A path from the same package version that does not go through `viaPackages` is NOT excepted.
 * Entry shape: `{ advisory: 'GHSA-…', viaPackages: [...], expires: 'YYYY-MM-DD' (exclusive, UTC),
 * issue: '<url of the issue that removes it>' }`.
 */
export const EXCEPTIONS = [];

const GATED = new Set(['moderate', 'high', 'critical']);

/** The GHSA id of an advisory `via` object (`url` is https://github.com/advisories/GHSA-…). */
function advisoryId(via) {
  return typeof via.url === 'string' ? via.url.split('/').pop() : undefined;
}

/**
 * Evaluate an `npm audit --json` report (auditReportVersion 2) against a list of exceptions.
 * @param {any} report parsed `npm audit --json` output
 * @param {string} today UTC date, `YYYY-MM-DD`
 * @param {typeof EXCEPTIONS} exceptions the exceptions to apply (EXCEPTIONS; a test passes its own)
 * @returns {{ failures: string[], excepted: string[] }} package names that fail / are excepted
 */
export function evaluateAudit(report, today, exceptions = EXCEPTIONS) {
  const vulns = report?.vulnerabilities;
  if (!vulns || typeof vulns !== 'object') {
    throw new Error('npm audit --json output has no "vulnerabilities" object (audit did not run?)');
  }
  const active = exceptions.filter((e) => today < e.expires);
  const memo = new Map();

  /** Is the finding on package `name` covered by exception `ex`? */
  function covered(ex, name, trail = []) {
    const key = `${ex.advisory}:${name}`;
    if (memo.has(key)) return memo.get(key);
    if (trail.includes(name)) return false;
    const v = vulns[name];
    let ok = false;
    if (v && Array.isArray(v.via) && v.via.length > 0 && Array.isArray(v.effects)) {
      const advisories = v.via.filter((x) => typeof x === 'object');
      const parents = v.via.filter((x) => typeof x === 'string');
      const viaOk =
        advisories.every((a) => advisoryId(a) === ex.advisory) &&
        parents.every((p) => covered(ex, p, [...trail, name]));
      // Every dependent of this package must be one of the excepted route's packages.
      const effectsOk = v.effects.every((e) => ex.viaPackages.includes(e));
      if (advisories.length > 0) {
        // the vulnerable package itself: reached only through viaPackages, never a direct dependency
        ok = viaOk && !v.isDirect && v.effects.length > 0 && effectsOk;
      } else {
        // a package on the route: must itself be one of viaPackages
        ok = viaOk && ex.viaPackages.includes(name) && effectsOk;
      }
    }
    memo.set(key, ok);
    return ok;
  }

  const failures = [];
  const excepted = [];
  for (const [name, v] of Object.entries(vulns)) {
    if (!GATED.has(v.severity)) continue;
    (active.some((ex) => covered(ex, name)) ? excepted : failures).push(name);
  }
  return { failures, excepted };
}

function main() {
  const today = new Date().toISOString().slice(0, 10);
  // npm audit exits 1 when it finds anything; the verdict here comes from the JSON, not the exit code.
  const r = spawnSync('npm', ['audit', '--audit-level=moderate', '--json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  let report;
  try {
    report = JSON.parse(r.stdout);
  } catch {
    console.error('✗ audit: npm audit did not return JSON.');
    console.error(r.stderr || r.stdout || r.error);
    process.exit(1);
  }
  if (report.error) {
    console.error(`✗ audit: npm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}`);
    process.exit(1);
  }
  let result;
  try {
    result = evaluateAudit(report, today);
  } catch (e) {
    console.error(`✗ audit: ${e.message}`);
    process.exit(1);
  }
  const { failures, excepted } = result;
  for (const ex of EXCEPTIONS) {
    const hit = excepted.length > 0 && today < ex.expires;
    if (hit) {
      console.error(
        `⚠️  audit: ${ex.advisory} excepted via ${ex.viaPackages.join(', ')} until ${ex.expires} ` +
          `(${excepted.join(', ')}); remove: ${ex.issue}`,
      );
    } else if (today >= ex.expires) {
      console.error(`⚠️  audit: exception for ${ex.advisory} expired on ${ex.expires}; see ${ex.issue}`);
    }
  }
  if (failures.length > 0) {
    console.error(`✗ audit: ${failures.length} moderate-or-higher finding(s) not excepted: ${failures.join(', ')}`);
    console.error('  Run `npm audit` for the advisories.');
    process.exit(1);
  }
  console.log('✓ audit: no moderate-or-higher finding outside the listed exceptions.');
}

// Run only when invoked as a script (the unit test imports evaluateAudit).
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
