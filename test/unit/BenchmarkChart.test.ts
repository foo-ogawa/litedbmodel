/**
 * Benchmark chart normalisation tests.
 *
 * The chart claims every bar is a RATIO against one baseline series. Nothing checked that claim: the
 * bench-docs drift gate only compares a regenerated SVG against the committed one, so a chart whose
 * ratios were raw milliseconds regenerated identically and stayed green. These tests read the real
 * renderer (`generateSVG`, the same function the generator script calls) and assert the arithmetic.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parseCSV, generateSVG, type BenchmarkRow } from '../../benchmark/generate-chart.js';
import { ORM_SERIES, BASELINE_SERIES, SUBJECT_SERIES, type OrmSeries } from '../../benchmark/orm-series.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CSV_PATH = path.join(REPO_ROOT, 'benchmark', 'results', 'benchmark-results.csv');

/**
 * The bar labels the chart draws, grouped by operation. `generateSVG` emits one `op-label` per
 * operation followed by one label per series in ORM_SERIES order, so the labels can be read back in
 * that order and checked against the numbers they were computed from.
 */
function readBarLabels(svg: string): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const [, cls, text] of svg.matchAll(/class="(op-label|value-label|value-overflow|na-text)">([^<]*)</g)) {
    if (cls === 'op-label') {
      current = [];
      groups.set(text, current);
    } else {
      expect(current, 'a bar label appeared before any operation label').toBeDefined();
      current!.push(text);
    }
  }
  return groups;
}

/** A CSV row. `orm` is an OrmSeries here — a fixture naming a series that does not exist proves nothing. */
function row(operation: string, orm: OrmSeries, median: number): BenchmarkRow {
  return { operation, orm, median, iqr: 0, stdDev: 0, min: median, max: median, iterations: 250 };
}

describe('benchmark chart normalisation', () => {
  it('draws the baseline series at exactly 1.00x in every operation', async () => {
    const rows = await parseCSV(CSV_PATH);
    const groups = readBarLabels(generateSVG(rows));

    expect(groups.size).toBe(new Set(rows.map((r) => r.operation)).size);

    const baselineIndex = ORM_SERIES.indexOf(BASELINE_SERIES);
    for (const [operation, labels] of groups) {
      expect(labels, `bar count for "${operation}"`).toHaveLength(ORM_SERIES.length);
      expect(labels[baselineIndex], `${BASELINE_SERIES} bar for "${operation}"`).toMatch(/^1\.00x /);
    }
  });

  it('divides every other series by the baseline median of the SAME operation', () => {
    const rows = [
      row('op', BASELINE_SERIES, 2),
      row('op', 'Kysely', 4),
      row('op', 'Drizzle', 1),
    ];

    const labels = readBarLabels(generateSVG(rows)).get('op')!;

    expect(labels[ORM_SERIES.indexOf(BASELINE_SERIES)]).toBe('1.00x (2.00ms)');
    expect(labels[ORM_SERIES.indexOf('Kysely')]).toBe('2.00x (4.00ms)');
    expect(labels[ORM_SERIES.indexOf('Drizzle')]).toBe('0.50x (1.00ms)');
  });

  it('refuses to render an operation with no baseline row instead of defaulting the divisor', () => {
    const rows = [row('op', 'Kysely', 4), row('op', 'Drizzle', 1)];

    expect(() => generateSVG(rows)).toThrow(`No "${BASELINE_SERIES}" row for operation "op"`);
  });

  it('measures the series the committed CSV actually carries', async () => {
    const rows = await parseCSV(CSV_PATH);

    expect([...new Set(rows.map((r) => r.orm))].sort()).toEqual([...ORM_SERIES].sort());
    expect(ORM_SERIES).toContain(BASELINE_SERIES);
    expect(SUBJECT_SERIES).toContain(BASELINE_SERIES);
  });
});
