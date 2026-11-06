/**
 * scripts/check-audit.mjs — the one place that decides which `npm audit` findings are excepted (#335).
 * Inputs are `npm audit --json` (auditReportVersion 2) shaped reports.
 */
import { describe, it, expect } from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// A computed specifier: the script is plain .mjs and has no type declarations.
const mod: { evaluateAudit(report: unknown, today: string): { failures: string[]; excepted: string[] } } =
  await import(pathToFileURL(resolve(__dirname, '../../scripts/check-audit.mjs')).href);

const GHSA = 'GHSA-g3hv-75wg-m249';
const advisory = (id: string) => ({
  source: 1,
  name: 'minimatch',
  dependency: 'minimatch',
  title: 't',
  url: `https://github.com/advisories/${id}`,
  severity: 'moderate',
  range: '>=7.0.0 <11.0.1',
});
const entry = (via: unknown[], effects: string[], extra: Record<string, unknown> = {}) => ({
  severity: 'moderate',
  isDirect: false,
  via,
  effects,
  ...extra,
});
/** The report the lockfile produces today: minimatch <- typedoc <- typedoc-plugin-markdown. */
const typedocReport = (minimatch = entry([advisory(GHSA)], ['typedoc'])) => ({
  vulnerabilities: {
    minimatch,
    typedoc: entry(['minimatch'], ['typedoc-plugin-markdown'], { isDirect: true }),
    'typedoc-plugin-markdown': entry(['typedoc'], [], { isDirect: true }),
  },
});
const BEFORE = '2027-02-06';
const AFTER = '2027-02-07';

describe('check-audit evaluateAudit', () => {
  it('(a) passes when the only findings are the excepted advisory through typedoc', () => {
    const r = mod.evaluateAudit(typedocReport(), BEFORE);
    expect(r.failures).toEqual([]);
    expect(r.excepted.sort()).toEqual(['minimatch', 'typedoc', 'typedoc-plugin-markdown']);
  });

  it('(b) fails for the same advisory reached by a path that does not go through typedoc', () => {
    const other = typedocReport(entry([advisory(GHSA)], ['typedoc', 'some-other-tool']));
    expect(mod.evaluateAudit(other, BEFORE).failures).toContain('minimatch');
    const direct = typedocReport(entry([advisory(GHSA)], ['typedoc'], { isDirect: true }));
    expect(mod.evaluateAudit(direct, BEFORE).failures).toContain('minimatch');
    const alone = {
      vulnerabilities: { minimatch: entry([advisory(GHSA)], ['@typescript-eslint/typescript-estree']) },
    };
    expect(mod.evaluateAudit(alone, BEFORE).failures).toEqual(['minimatch']);
  });

  it('(c) fails for a different advisory, also when it sits next to the excepted one', () => {
    const r = mod.evaluateAudit(typedocReport(entry([advisory('GHSA-xxxx-yyyy-zzzz')], ['typedoc'])), BEFORE);
    expect(r.failures).toContain('minimatch');
    const mixed = typedocReport(entry([advisory(GHSA), advisory('GHSA-xxxx-yyyy-zzzz')], ['typedoc']));
    expect(mod.evaluateAudit(mixed, BEFORE).failures).toContain('minimatch');
    const extra = typedocReport();
    (extra.vulnerabilities as Record<string, unknown>).lodash = entry([advisory('GHSA-aaaa-bbbb-cccc')], []);
    expect(mod.evaluateAudit(extra, BEFORE).failures).toEqual(['lodash']);
  });

  it('(d) fails once the deadline (2027-02-07) has passed', () => {
    const r = mod.evaluateAudit(typedocReport(), AFTER);
    expect(r.excepted).toEqual([]);
    expect(r.failures.sort()).toEqual(['minimatch', 'typedoc', 'typedoc-plugin-markdown']);
  });

  it('ignores severities below moderate and rejects a report with no vulnerabilities object', () => {
    expect(mod.evaluateAudit({ vulnerabilities: { x: { ...entry([], []), severity: 'low' } } }, BEFORE).failures).toEqual([]);
    expect(() => mod.evaluateAudit({}, BEFORE)).toThrow();
  });
});
