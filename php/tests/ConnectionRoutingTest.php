<?php

declare(strict_types=1);

namespace LiteDbModel\Runtime\Tests;

use LiteDbModel\Runtime\ConnectionConfig;
use LiteDbModel\Runtime\ConnectionRegistry;
use LiteDbModel\Runtime\ConnectionRegistryBuilder;
use LiteDbModel\Runtime\PdoPool;
use LiteDbModel\Runtime\PdoPoolFactory;
use LiteDbModel\Runtime\PdoDriver;
use LiteDbModel\Runtime\ReaderWriterPools;
use LiteDbModel\Runtime\RoutingConfig;
use LiteDbModel\Runtime\StatementIntent;
use LiteDbModel\Runtime\WriterStickyClock;
use LiteDbModel\Runtime\Connection;
use LiteDbModel\Runtime\RunInfo;
use PHPUnit\Framework\TestCase;

use function LiteDbModel\Runtime\inWriterScope;
use function LiteDbModel\Runtime\resolveConnectionConfig;
use function LiteDbModel\Runtime\resolvePool;
use function LiteDbModel\Runtime\sessionResetStatements;
use function LiteDbModel\Runtime\sessionStatements;
use function LiteDbModel\Runtime\withWriter;

/**
 * Phase C (#91, PHP) — PURE-UNIT tests for the connection routing + config contract (no DB). These
 * pin the parts of the TS contract that are dialect-neutral and connectionless: the C3 config defaults,
 * the per-dialect session-statement mapping (+ reset), the C2 registry loud-fail, the C1 resolvePool
 * priority order, the injectable writer-sticky clock, and the withWriter scope marker. The LIVE proofs
 * (real PG/MySQL, mutation RED→GREEN) are in {@see ConnectionRoutingLiveTest}.
 */
final class ConnectionRoutingTest extends TestCase
{
    // ── C3 config defaults (mirror the TS resolveConnectionConfig defaults) ──────

    public function testResolveConnectionConfigDefaults(): void
    {
        $r = resolveConnectionConfig();
        $this->assertSame('postgres', $r->driver);
        $this->assertSame(0, $r->queryTimeout);
        $this->assertFalse($r->keepAlive);
        $this->assertSame(10000, $r->keepAliveInitialDelayMillis);
        $this->assertSame(0, $r->minPool);
        $this->assertSame(10, $r->maxPool);
        $this->assertSame(30000, $r->connectTimeoutMillis);
        $this->assertSame(10000, $r->idleTimeoutMillis);
        $this->assertNull($r->searchPath);
        $this->assertNull($r->charset);
    }

    public function testResolveConnectionConfigCarriesOverrides(): void
    {
        $r = resolveConnectionConfig(new ConnectionConfig(
            driver: 'mysql',
            queryTimeout: 250,
            keepAlive: true,
            maxPool: 3,
            connectTimeoutMillis: 1500,
            idleTimeoutMillis: 250,
            searchPath: 'app,public',
            charset: 'utf8mb4',
        ));
        $this->assertSame('mysql', $r->driver);
        $this->assertSame(250, $r->queryTimeout);
        $this->assertTrue($r->keepAlive);
        $this->assertSame(3, $r->maxPool);
        $this->assertSame(1500, $r->connectTimeoutMillis);
        $this->assertSame(250, $r->idleTimeoutMillis);
        $this->assertSame('app,public', $r->searchPath);
        $this->assertSame('utf8mb4', $r->charset);
    }

    /**
     * connectTimeoutMillis bounds opening a PG connection: against a server that completes the TCP
     * handshake and never answers (a listening socket that is never accepted — the kernel still queues
     * the connection), the factory fails after the bound rounded UP to whole seconds (300 ms ⇒ 1 s),
     * instead of pdo_pgsql's own 30 s.
     */
    public function testConnectTimeoutBoundsStalledPgServer(): void
    {
        $server = stream_socket_server('tcp://127.0.0.1:0');
        $this->assertNotFalse($server);
        $address = (string) stream_socket_get_name($server, false);
        $port = (int) substr($address, (int) strrpos($address, ':') + 1);
        $config = resolveConnectionConfig(new ConnectionConfig(
            driver: 'postgres',
            host: '127.0.0.1',
            port: $port,
            database: 'x',
            user: 'u',
            password: 'p',
            connectTimeoutMillis: 300,
        ));
        $start = microtime(true);
        try {
            (new PdoPoolFactory())->build($config, 'reader');
            $this->fail('the factory connected to a server that never answers');
        } catch (\PDOException $e) {
            $elapsed = microtime(true) - $start;
            $this->assertGreaterThanOrEqual(1.0, $elapsed, 'the bound is never shorter than configured');
            $this->assertLessThan(2.5, $elapsed, "connect gave up after {$elapsed}s, want ~1s: {$e->getMessage()}");
        } finally {
            fclose($server);
        }
    }

    /**
     * connectTimeoutMillis = 0 is no limit for PG: `ATTR_TIMEOUT = 0` reaches libpq as
     * `connect_timeout=0`, which waits indefinitely. The connect runs in a child process (it does not
     * return on its own) against a server that never answers; two seconds later — past the smallest
     * bound `ATTR_TIMEOUT` can express (1 s) — it is still connecting.
     */
    public function testConnectTimeoutZeroIsNoLimitForPg(): void
    {
        $server = stream_socket_server('tcp://127.0.0.1:0');
        $this->assertNotFalse($server);
        $address = (string) stream_socket_get_name($server, false);
        $port = (int) substr($address, (int) strrpos($address, ':') + 1);
        $code = sprintf(
            'require %s; (new \\LiteDbModel\\Runtime\\PdoPoolFactory())->build(\\LiteDbModel\\Runtime\\resolveConnectionConfig('
            . 'new \\LiteDbModel\\Runtime\\ConnectionConfig(driver: "postgres", host: "127.0.0.1", port: %d, database: "x",'
            . ' user: "u", password: "p", connectTimeoutMillis: 0)), "reader");',
            var_export(dirname(__DIR__) . '/vendor/autoload.php', true),
            $port,
        );
        $child = proc_open([PHP_BINARY, '-r', $code], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        $this->assertIsResource($child);
        try {
            usleep(2_000_000);
            $status = proc_get_status($child);
            if (!$status['running']) {
                $this->fail("connectTimeoutMillis=0: the connect ended within 2 s (exit {$status['exitcode']}): "
                    . stream_get_contents($pipes[1]) . stream_get_contents($pipes[2]));
            }
            $this->addToAssertionCount(1);
        } finally {
            fclose($server);
            proc_terminate($child, 9); // SIGKILL: libpq's connect does not end on SIGTERM
            proc_close($child);
        }
    }

    /**
     * connectTimeoutMillis = 0 is no limit for MySQL too. pdo_mysql bounds a TCP connect that has no
     * ATTR_TIMEOUT by php.ini `default_socket_timeout`; the factory lifts it for the construction only.
     * The connect runs in a child process started with `default_socket_timeout=1` against a listener
     * whose accept queue is full (the kernel drops the SYNs, so the TCP connect itself waits): two
     * seconds later it is still connecting. Once the listener goes away the connect fails, and the
     * child reports `default_socket_timeout` back at 1.
     */
    public function testConnectTimeoutZeroIsNoLimitForMysql(): void
    {
        $server = stream_socket_server(
            'tcp://127.0.0.1:0',
            $errno,
            $errstr,
            STREAM_SERVER_BIND | STREAM_SERVER_LISTEN,
            stream_context_create(['socket' => ['backlog' => 1]]),
        );
        $this->assertNotFalse($server, $errstr);
        $address = (string) stream_socket_get_name($server, false);
        $port = (int) substr($address, (int) strrpos($address, ':') + 1);
        $queued = [];
        for ($i = 0; $i < 8; $i++) {
            $queued[] = @stream_socket_client("tcp://127.0.0.1:{$port}", $errno, $errstr, 0.2, STREAM_CLIENT_CONNECT | STREAM_CLIENT_ASYNC_CONNECT);
        }
        $code = sprintf(
            'require %s; try { (new \LiteDbModel\Runtime\PdoPoolFactory())->build(\LiteDbModel\Runtime\resolveConnectionConfig('
            . 'new \LiteDbModel\Runtime\ConnectionConfig(driver: "mysql", host: "127.0.0.1", port: %d, database: "x",'
            . ' user: "u", password: "p", connectTimeoutMillis: 0)), "reader"); } catch (\PDOException $e) {'
            . ' echo "connect failed: ", $e->getMessage(), "\n"; } echo "default_socket_timeout=", ini_get("default_socket_timeout"), "\n";',
            var_export(dirname(__DIR__) . '/vendor/autoload.php', true),
            $port,
        );
        $child = proc_open([PHP_BINARY, '-d', 'default_socket_timeout=1', '-r', $code], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        $this->assertIsResource($child);
        try {
            usleep(2_000_000);
            $status = proc_get_status($child);
            if (!$status['running']) {
                $this->fail("connectTimeoutMillis=0: the MySQL connect ended within 2 s (exit {$status['exitcode']}): "
                    . stream_get_contents($pipes[1]) . stream_get_contents($pipes[2]));
            }
            fclose($server); // the listener goes away ⇒ the connect fails
            foreach ($queued as $q) {
                if (is_resource($q)) {
                    fclose($q);
                }
            }
            $deadline = microtime(true) + 20;
            while (proc_get_status($child)['running'] && microtime(true) < $deadline) {
                usleep(100_000);
            }
            $this->assertFalse(proc_get_status($child)['running'], 'the connect did not end after the listener closed');
            $out = stream_get_contents($pipes[1]) . stream_get_contents($pipes[2]);
            $this->assertStringContainsString('connect failed:', $out);
            $this->assertStringContainsString("default_socket_timeout=1\n", $out, 'the ini is restored after the connect');
        } finally {
            if (is_resource($server)) {
                fclose($server);
            }
            proc_terminate($child, 9);
            proc_close($child);
        }
    }

    // ── C3 session-statement mapping (mirror the TS sessionStatements table) ─────

    public function testSessionStatementsPostgres(): void
    {
        $this->assertSame(
            ['SET statement_timeout = 250'],
            sessionStatements(resolveConnectionConfig(new ConnectionConfig(driver: 'postgres', queryTimeout: 250))),
        );
        $this->assertSame(
            ['SET search_path TO app,public'],
            sessionStatements(resolveConnectionConfig(new ConnectionConfig(driver: 'postgres', searchPath: 'app,public'))),
        );
        $this->assertSame(
            ['SET client_encoding TO UTF8'],
            sessionStatements(resolveConnectionConfig(new ConnectionConfig(driver: 'postgres', charset: 'UTF8'))),
        );
    }

    public function testSessionStatementsMysql(): void
    {
        $this->assertSame(
            ['SET SESSION max_execution_time = 250'],
            sessionStatements(resolveConnectionConfig(new ConnectionConfig(driver: 'mysql', queryTimeout: 250))),
        );
        $this->assertSame(
            ['SET NAMES utf8mb4'],
            sessionStatements(resolveConnectionConfig(new ConnectionConfig(driver: 'mysql', charset: 'utf8mb4'))),
        );
        // MySQL has no schema search path → ignored.
        $this->assertSame(
            [],
            sessionStatements(resolveConnectionConfig(new ConnectionConfig(driver: 'mysql', searchPath: 'x'))),
        );
    }

    public function testSessionStatementsAllDefaultIsEmpty(): void
    {
        // Backward-compat: an all-default config leaves the session UNTOUCHED (byte-identical).
        $this->assertSame([], sessionStatements(resolveConnectionConfig()));
        $this->assertSame([], sessionResetStatements(resolveConnectionConfig()));
        // sqlite has no server session.
        $this->assertSame([], sessionStatements(resolveConnectionConfig(new ConnectionConfig(driver: 'sqlite', queryTimeout: 100))));
    }

    public function testSessionResetStatements(): void
    {
        $this->assertSame(
            ['RESET statement_timeout', 'RESET search_path'],
            sessionResetStatements(resolveConnectionConfig(new ConnectionConfig(driver: 'postgres', queryTimeout: 10, searchPath: 'a'))),
        );
        $this->assertSame(
            ['SET SESSION max_execution_time = DEFAULT', 'SET NAMES DEFAULT'],
            sessionResetStatements(resolveConnectionConfig(new ConnectionConfig(driver: 'mysql', queryTimeout: 10, charset: 'utf8mb4'))),
        );
    }

    // ── C2 registry loud-fail on an unknown name (never a silent default) ────────

    public function testRegistryUnknownNameIsLoud(): void
    {
        $pool = new FakePool('p');
        $registry = ConnectionRegistry::singleDefault($pool);
        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessageMatches("/no connection registered under name 'ghost'/");
        $registry->pairFor('ghost');
    }

    public function testRegistryBuilderRequiresAtLeastDefault(): void
    {
        $this->expectException(\RuntimeException::class);
        (new ConnectionRegistryBuilder())->build();
    }

    public function testRegistryNamesAndDistinctPools(): void
    {
        $a = new FakePool('A');
        $b = new FakePool('B');
        $registry = new ConnectionRegistry([
            'default' => ReaderWriterPools::single($a),
            'B' => ReaderWriterPools::single($b),
        ]);
        $this->assertSame(['default', 'B'], $registry->names());
        // reader===writer counts once per connection ⇒ 2 distinct pools.
        $this->assertCount(2, $registry->distinctPools());
    }

    // ── C1 resolvePool priority order (mirror the TS resolvePool) ────────────────

    public function testResolvePoolReadGoesToReaderWriteToWriter(): void
    {
        $reader = new FakePool('reader');
        $writer = new FakePool('writer');
        $routing = new RoutingConfig(
            ConnectionRegistry::fromDefault(new ReaderWriterPools($reader, $writer))->build(),
            new WriterStickyClock(useWriterAfterTransaction: false),
        );
        $this->assertSame($reader, resolvePool(new StatementIntent(write: false), $routing));
        $this->assertSame($writer, resolvePool(new StatementIntent(write: true), $routing));
    }

    public function testResolvePoolStickyReadGoesToWriter(): void
    {
        $reader = new FakePool('reader');
        $writer = new FakePool('writer');
        $clock = 1_000_000.0;
        $sticky = new WriterStickyClock(useWriterAfterTransaction: true, writerStickyDuration: 5000, now: function () use (&$clock) {
            return $clock;
        });
        $routing = new RoutingConfig(ConnectionRegistry::fromDefault(new ReaderWriterPools($reader, $writer))->build(), $sticky);

        // Before any mark ⇒ reader.
        $this->assertSame($reader, resolvePool(new StatementIntent(write: false), $routing));
        // After a mark, within the window ⇒ writer (read-your-writes).
        $sticky->mark();
        $clock += 100;
        $this->assertSame($writer, resolvePool(new StatementIntent(write: false), $routing));
        // After the window elapses ⇒ back to reader.
        $clock += 6000;
        $this->assertSame($reader, resolvePool(new StatementIntent(write: false), $routing));
    }

    public function testResolvePoolNamedDbSelectsThePair(): void
    {
        $aReader = new FakePool('A-reader');
        $bReader = new FakePool('B-reader');
        $routing = new RoutingConfig(
            new ConnectionRegistry([
                'default' => ReaderWriterPools::single($aReader),
                'B' => ReaderWriterPools::single($bReader),
            ]),
            new WriterStickyClock(useWriterAfterTransaction: false),
        );
        $this->assertSame($aReader, resolvePool(new StatementIntent(write: false), $routing));
        $this->assertSame($bReader, resolvePool(new StatementIntent(write: false, db: 'B'), $routing));
        // An unknown db is loud even through resolvePool.
        $this->expectException(\RuntimeException::class);
        resolvePool(new StatementIntent(write: false, db: 'ghost'), $routing);
    }

    // ── C1 withWriter scope marker (routing half) ────────────────────────────────

    public function testWithWriterScopeDivertsReadsToWriter(): void
    {
        $reader = new FakePool('reader');
        $writer = new FakePool('writer');
        $routing = new RoutingConfig(
            ConnectionRegistry::fromDefault(new ReaderWriterPools($reader, $writer))->build(),
            new WriterStickyClock(useWriterAfterTransaction: false),
        );
        $this->assertFalse(inWriterScope());
        // Outside the scope ⇒ reader.
        $this->assertSame($reader, resolvePool(new StatementIntent(write: false), $routing));
        // Inside withWriter ⇒ writer, and the scope marker is active.
        $inside = withWriter(function () use ($routing, $writer) {
            $this->assertTrue(inWriterScope());
            return resolvePool(new StatementIntent(write: false), $routing);
        });
        $this->assertSame($writer, $inside);
        // The scope is restored on exit ⇒ reader again.
        $this->assertFalse(inWriterScope());
        $this->assertSame($reader, resolvePool(new StatementIntent(write: false), $routing));
    }

    public function testWriterStickyDisabledNeverSticks(): void
    {
        $clock = new WriterStickyClock(useWriterAfterTransaction: false);
        $clock->mark();
        $this->assertFalse($clock->isSticky());
    }

    /**
     * #218 t=0 REGRESSION: a mark() when the clock reads 0 MUST arm stickiness, so the read right after
     * the commit routes to the WRITER (read-your-writes). The old code stored 0.0 as "never marked" (a
     * value sentinel) → the commit failed to stick and the read leaked to the reader replica. Revert
     * $lastWriteAt to 0.0 + `=== 0.0` ⇒ both asserts below go RED. Every OTHER sticky test marks at a
     * non-zero clock, so this t=0 case was previously unproven.
     */
    public function testWriterStickyArmedAtClockZero(): void
    {
        $reader = new FakePool('reader');
        $writer = new FakePool('writer');
        $sticky = new WriterStickyClock(useWriterAfterTransaction: true, writerStickyDuration: 5000, now: static fn (): float => 0.0);
        $routing = new RoutingConfig(ConnectionRegistry::fromDefault(new ReaderWriterPools($reader, $writer))->build(), $sticky);
        // Before any mark ⇒ reader (absence, not sticky), even at t=0.
        $this->assertSame($reader, resolvePool(new StatementIntent(write: false), $routing));
        // A commit at clock t=0 arms the sticky clock.
        $sticky->mark();
        $this->assertSame($writer, resolvePool(new StatementIntent(write: false), $routing));
    }
}

/**
 * A minimal in-memory {@see PdoPool} for the pure-unit resolvePool/registry tests — it never touches a
 * `\PDO`. `acquire`/`release` are no-ops; `execute`/`run` are unused (resolvePool returns the pool
 * object, and the unit tests assert on identity, not on running SQL).
 */
final class FakePool implements PdoPool
{
    public function __construct(private readonly string $label)
    {
    }

    public function label(): string
    {
        return $this->label;
    }

    public function acquire(): Connection
    {
        throw new \LogicException('FakePool::acquire not used in unit tests');
    }

    public function release(Connection $conn, bool $destroy = false): void
    {
    }

    public function close(): void
    {
    }

    public function driver(): string
    {
        return 'postgres';
    }

    public function backingDriver(): PdoDriver
    {
        throw new \LogicException('FakePool::backingDriver not used in unit tests');
    }
}
