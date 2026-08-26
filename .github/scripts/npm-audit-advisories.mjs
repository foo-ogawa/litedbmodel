#!/usr/bin/env node
// Advisory-level view of `npm audit`, for the remediation workflow.
//
// `npm audit`'s exit code only reports whether anything at or above a threshold survives. That
// cannot tell an advisory the lockfile fix was unable to reach — an exact pin, a fix that needs
// a semver-major, an advisory with no upstream fix at all — from one the fix dragged in. Only
// the first is acceptable, so the workflow states its gate as a set operation over advisory
// ids instead of over an exit code.
//
//   node npm-audit-advisories.mjs --level <threshold>
//     Print one `id \t tree \t severity \t url \t title` line per advisory, sorted.
//
//   node npm-audit-advisories.mjs --level <threshold> --against <file> [--residual <file>]
//     Recompute and exit 1 if any advisory is missing from <file>. Advisories already in
//     <file> survived the fix; those are written to <file> as markdown for the report.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";

const RANK = ["info", "low", "moderate", "high", "critical"];

const option = (name) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};

const threshold = RANK.indexOf(option("--level") ?? "moderate");
if (threshold === -1) throw new Error(`unknown --level: ${option("--level")}`);

// Every lockfile in the repository, the root first. `git ls-files` keeps the set in step with
// the repository — a hand-written list goes stale the day someone adds a lockfile.
const trees = [
  ".",
  ...execFileSync("git", ["ls-files", "*/package-lock.json"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map(dirname),
];

// Read the lockfiles rather than an install: the fix rewrites them, while node_modules still
// holds the tree from before it.
const found = new Map();
for (const tree of trees) {
  let raw;
  try {
    raw = execFileSync("npm", ["audit", "--package-lock-only", "--json"], {
      cwd: tree,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    raw = error.stdout; // npm exits non-zero whenever it found anything
  }
  let report;
  try {
    report = JSON.parse(raw ?? "");
  } catch {
    continue;
  }
  for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
    // A `via` string is this entry re-exporting a parent entry's advisory; only the objects
    // carry one of their own.
    for (const via of vulnerability.via ?? []) {
      if (typeof via !== "object" || via.source == null) continue;
      if (RANK.indexOf(via.severity) < threshold) continue;
      const key = `${via.source}\t${tree}`;
      const cell = (value) => String(value ?? "").replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
      found.set(key, `${key}\t${via.severity}\t${via.url ?? ""}\t${cell(via.title)}`);
    }
  }
}

const against = option("--against");
if (!against) {
  process.stdout.write([...found.values()].sort().map((line) => `${line}\n`).join(""));
  process.exit(0);
}

// An advisory is identified by its id and the tree it sits in, never by the whole line: an
// upstream title edit must not read as a new finding.
const baseline = new Set(
  readFileSync(against, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t").slice(0, 2).join("\t")),
);
const introduced = [...found].filter(([key]) => !baseline.has(key)).map(([, line]) => line);
const surviving = [...found].filter(([key]) => baseline.has(key)).map(([, line]) => line).sort();

const residual = option("--residual");
if (residual) writeFileSync(residual, surviving.length ? asMarkdown(surviving) : "");

if (introduced.length) {
  const report = ["::error::the lockfile fix pulled in advisories that were not there before it ran", ...introduced.sort()];
  process.stdout.write(report.map((line) => `${line}\n`).join(""));
  process.exit(1);
}

function asMarkdown(lines) {
  return [
    "",
    "Left open — no lockfile change reaches these, so they need a decision:",
    "",
    "| advisory | severity | tree | finding |",
    "| --- | --- | --- | --- |",
    ...lines.map((line) => {
      const [, tree, severity, url, title] = line.split("\t");
      return `| ${url || "-"} | ${severity} | \`${tree}\` | ${title} |`;
    }),
    "",
  ].join("\n");
}
