<?php

declare(strict_types=1);

namespace LiteDbModel\Runtime\Tests;

use PHPUnit\Framework\TestCase;

/**
 * Frozen-corpus conformance test (WS7d #33; leaf/emitter cutover #144) — the §10 language axis.
 *
 * The PHP leg runs the module bc GENERATED for it from the SAME declaration the TS leg runs, bound
 * to a LIVE PostgreSQL / MySQL through the op-agnostic leaf transport. A leaf-executed module needs
 * a live in-process handle, so there is nothing to replay from a serialized bundle and no in-proc
 * substitute for this bar: the runner IS the test, and this class drives it.
 *
 * Two levels, so a plain `phpunit` (no docker) still guards everything that needs no server:
 *
 *   - the corpus CONTRACT — supported version, both live dialects carrying the SAME declared
 *     endpoints, and a seeded schema. A drifted corpus fails here with no database in the loop.
 *   - the live BAR — the whole runner against real PG + MySQL, asserting the statements the leaf
 *     handed the driver, the FULL nested result (relation children and their field values) and the
 *     post-write DB state. Gated behind LITEDBMODEL_LIVEDB=1 (+ `npm run docker:livedb:up`):
 *
 *         LITEDBMODEL_LIVEDB=1 ./vendor/bin/phpunit --filter ConformanceCorpusTest
 */
final class ConformanceCorpusTest extends TestCase
{
    private const LIVE_DIALECTS = ['postgres', 'mysql'];

    private static function corpus(): \stdClass
    {
        $path = dirname(__DIR__, 2) . '/conformance/vectors-livedb/livedb.json';
        return json_decode((string) file_get_contents($path), false, 512, JSON_THROW_ON_ERROR);
    }

    public function testCorpusIsTheSupportedVersion(): void
    {
        // The runner pins the same constant; a bump must land on both sides together.
        self::assertSame(5, self::corpus()->corpusVersion);
    }

    public function testCorpusCoversBothLiveDialectsWithTheSameCases(): void
    {
        $byDialect = [];
        foreach (self::corpus()->vectors as $v) {
            $byDialect[$v->dialect][$v->entry] = true;
        }
        foreach (self::LIVE_DIALECTS as $d) {
            self::assertNotEmpty($byDialect[$d] ?? [], "the corpus carries no {$d} vectors");
            ksort($byDialect[$d]);
        }
        // The SAME declared endpoints on both servers — what makes the §10 comparison meaningful.
        self::assertSame(array_keys($byDialect['postgres']), array_keys($byDialect['mysql']));
    }

    public function testEveryVectorNamesAnEndpointTheGeneratedModuleExposes(): void
    {
        $root = dirname(__DIR__, 2);
        foreach (self::LIVE_DIALECTS as $dialect) {
            $path = "{$root}/php/conformance/behaviors_{$dialect}.php";
            self::assertFileExists($path, 'run `npm run conformance:gen:livedb`');
            // The generated module and the corpus come from ONE declaration, so every vector's entry
            // must be a component of the module bc emitted — a stale artifact fails here, no DB.
            $names = require $path;
            foreach (self::corpus()->vectors as $v) {
                if ($v->dialect === $dialect) {
                    self::assertContains($v->entry, $names->COMPONENT_NAMES, $v->name);
                }
            }
        }
    }

    public function testLiveDbConformanceAllVectorsPass(): void
    {
        if (getenv('LITEDBMODEL_LIVEDB') !== '1') {
            self::markTestSkipped('set LITEDBMODEL_LIVEDB=1 + docker up');
        }
        $runner = dirname(__DIR__, 2) . '/php/conformance/livedb_runner.php';
        $out = [];
        $status = 0;
        exec(escapeshellarg(PHP_BINARY) . ' ' . escapeshellarg($runner) . ' 2>&1', $out, $status);
        self::assertSame(0, $status, implode("\n", $out));
    }
}
