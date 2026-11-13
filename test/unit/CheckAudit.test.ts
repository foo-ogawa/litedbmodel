/**
 * scripts/check-audit.mjs — the one place that decides which `npm audit` findings are excepted.
 * Inputs are `npm audit --json` (auditReportVersion 2) shaped reports. The repository ships no exception
 * (the last one, #335, went with typedoc in #369), so the mechanism is exercised with a fixture
 * exception of the same shape, and the shipped list is checked to be empty.
 */
import { describe, it, expect } from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

interface AuditException {
  advisory: string;
  viaPackages: string[];
  expires: string;
  issue: string;
}
// A computed specifier: the script is plain .mjs and has no type declarations.
const mod: {
  EXCEPTIONS: AuditException[];
  evaluateAudit(
    report: unknown,
    today: string,
    exceptions?: AuditException[],
  ): { failures: string[]; excepted: string[] };
} = await import(pathToFileURL(resolve(__dirname, '../../scripts/check-audit.mjs')).href);

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
/** A fixture exception: the advisory reached only through `tool` / `tool-plugin`, until 2027-02-07. */
const EXCEPTION: AuditException = {
  advisory: GHSA,
  viaPackages: ['tool', 'tool-plugin'],
  expires: '2027-02-07',
  issue: 'https://example.invalid/issue',
};
/** minimatch <- tool <- tool-plugin. */
const toolReport = (minimatch = entry([advisory(GHSA)], ['tool'])) => ({
  vulnerabilities: {
    minimatch,
    tool: entry(['minimatch'], ['tool-plugin'], { isDirect: true }),
    'tool-plugin': entry(['tool'], [], { isDirect: true }),
  },
});
const BEFORE = '2027-02-06';
const AFTER = '2027-02-07';
const evaluate = (report: unknown, today: string) => mod.evaluateAudit(report, today, [EXCEPTION]);

describe('check-audit evaluateAudit', () => {
  it('ships no exception: with the shipped list every gated finding fails', () => {
    expect(mod.EXCEPTIONS).toEqual([]);
    expect(mod.evaluateAudit(toolReport(), BEFORE).failures.sort()).toEqual(['minimatch', 'tool', 'tool-plugin']);
  });

  it('(a) passes when the only findings are the excepted advisory through the excepted packages', () => {
    const r = evaluate(toolReport(), BEFORE);
    expect(r.failures).toEqual([]);
    expect(r.excepted.sort()).toEqual(['minimatch', 'tool', 'tool-plugin']);
  });

  it('(b) fails for the same advisory reached by a path that does not go through the excepted packages', () => {
    const other = toolReport(entry([advisory(GHSA)], ['tool', 'some-other-tool']));
    expect(evaluate(other, BEFORE).failures).toContain('minimatch');
    const direct = toolReport(entry([advisory(GHSA)], ['tool'], { isDirect: true }));
    expect(evaluate(direct, BEFORE).failures).toContain('minimatch');
    const alone = {
      vulnerabilities: { minimatch: entry([advisory(GHSA)], ['@typescript-eslint/typescript-estree']) },
    };
    expect(evaluate(alone, BEFORE).failures).toEqual(['minimatch']);
  });

  it('(c) fails for a different advisory, also when it sits next to the excepted one', () => {
    const r = evaluate(toolReport(entry([advisory('GHSA-xxxx-yyyy-zzzz')], ['tool'])), BEFORE);
    expect(r.failures).toContain('minimatch');
    const mixed = toolReport(entry([advisory(GHSA), advisory('GHSA-xxxx-yyyy-zzzz')], ['tool']));
    expect(evaluate(mixed, BEFORE).failures).toContain('minimatch');
    const extra = toolReport();
    (extra.vulnerabilities as Record<string, unknown>).lodash = entry([advisory('GHSA-aaaa-bbbb-cccc')], []);
    expect(evaluate(extra, BEFORE).failures).toEqual(['lodash']);
  });

  it('(d) fails once the deadline has passed', () => {
    const r = evaluate(toolReport(), AFTER);
    expect(r.excepted).toEqual([]);
    expect(r.failures.sort()).toEqual(['minimatch', 'tool', 'tool-plugin']);
  });

  it('ignores severities below moderate and rejects a report with no vulnerabilities object', () => {
    expect(evaluate({ vulnerabilities: { x: { ...entry([], []), severity: 'low' } } }, BEFORE).failures).toEqual([]);
    expect(() => evaluate({}, BEFORE)).toThrow();
  });
});
