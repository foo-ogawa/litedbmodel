<?php

declare(strict_types=1);

namespace LiteDbModel\Runtime\Tests;

use LiteDbModel\Runtime\ConnectionConfig;
use LiteDbModel\Runtime\ConnectionSetup;
use LiteDbModel\Runtime\PdoPoolFactory;
use LiteDbModel\Runtime\StatementIntent;
use LiteDbModel\Runtime\TransactionOptions;
use PHPUnit\Framework\TestCase;

use function LiteDbModel\Runtime\currentContext;
use function LiteDbModel\Runtime\execute;
use function LiteDbModel\Runtime\routedTransaction;
use function LiteDbModel\Runtime\routingContext;
use function LiteDbModel\Runtime\runGuarded;
use function LiteDbModel\Runtime\setConfig;

/**
 * LIVE-DB: a transaction retry after a connection error runs only on a connection that passed a `SELECT 1`
 * probe, and the PHP driver replaces a connection that fails it by opening a new `\PDO` from its own
 * connection parameters ({@see \LiteDbModel\Runtime\PdoDriver::beginTx()}). The pool's connection is killed
 * by a separate admin connection (pg_terminate_backend / KILL, by its own id) while a loopback proxy
 * ({@see StaleProxy}) keeps the client socket open, as a load balancer or a failover does: the driver
 * still holds it and learns it is dead only by using it. transaction() then commits once.
 *
 * REAL DBs, no silent skip. Set LITEDBMODEL_SKIP_LIVE=1 to run only the pure-unit suite offline.
 */
final class ConnRetryLiveTest extends TestCase
{
    private const TBL = 'conn_retry_php';

    protected function setUp(): void
    {
        if (getenv('LITEDBMODEL_SKIP_LIVE') === '1') {
            $this->markTestSkipped('LITEDBMODEL_SKIP_LIVE=1 — live-DB retry test skipped');
        }
    }

    /**
     * @return array<string, array{0:string,1:string,2:int,3:string,4:string,5:string,6:string,7:string,8:string}>
     *         [driver, host, port, database, user, password, idSql, killSql, createSql]
     */
    public static function dialects(): array
    {
        return [
            'postgres' => [
                'postgres',
                getenv('TEST_DB_HOST') ?: 'localhost',
                (int) (getenv('TEST_DB_PORT') ?: '5433'),
                getenv('TEST_DB_NAME') ?: 'testdb',
                getenv('TEST_DB_USER') ?: 'testuser',
                getenv('TEST_DB_PASSWORD') ?: 'testpass',
                'SELECT pg_backend_pid() AS id',
                'SELECT pg_terminate_backend(%d)',
                'CREATE TABLE %s (id serial PRIMARY KEY, label text NOT NULL)',
            ],
            'mysql' => [
                'mysql',
                getenv('TEST_MYSQL_HOST') ?: '127.0.0.1',
                (int) (getenv('TEST_MYSQL_PORT') ?: '3307'),
                getenv('TEST_MYSQL_DB') ?: 'testdb',
                getenv('TEST_MYSQL_USER') ?: 'testuser',
                getenv('TEST_MYSQL_PASSWORD') ?: 'testpass',
                'SELECT CONNECTION_ID() AS id',
                'KILL %d',
                'CREATE TABLE %s (id int AUTO_INCREMENT PRIMARY KEY, label varchar(32) NOT NULL)',
            ],
        ];
    }

    #[\PHPUnit\Framework\Attributes\DataProvider('dialects')]
    public function testTransactionRetryAfterTheConnectionWasKilledCommitsOnce(
        string $driver,
        string $host,
        int $port,
        string $database,
        string $user,
        string $password,
        string $idSql,
        string $killSql,
        string $createSql,
    ): void {
        $prefix = $driver === 'postgres' ? 'pgsql' : 'mysql';
        $admin = new \PDO("$prefix:host=$host;port=$port;dbname=$database", $user, $password, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]);
        $admin->exec('DROP TABLE IF EXISTS ' . self::TBL);
        $admin->exec(sprintf($createSql, self::TBL));

        $proxy = proc_open(
            [PHP_BINARY, __DIR__ . '/StaleProxy.php', $host, (string) $port],
            [0 => ['pipe', 'r'], 1 => ['pipe', 'w']],
            $pipes,
        );
        $this->assertIsResource($proxy);
        try {
            $proxyPort = (int) trim((string) fgets($pipes[1]));
            $built = setConfig([new ConnectionSetup(new PdoPoolFactory(), new ConnectionConfig(
                driver: $driver,
                host: '127.0.0.1',
                port: $proxyPort,
                database: $database,
                user: $user,
                password: $password,
            ))]);
            $ctx = routingContext($built->routing);

            $id = (int) execute($ctx, $idSql, [], new StatementIntent(write: true))[0]->id;
            fwrite($pipes[0], "stale\n");
            $this->assertSame('ok', trim((string) fgets($pipes[1])));
            $admin->query(sprintf($killSql, $id));

            $insert = 'INSERT INTO ' . self::TBL . ' (label) VALUES (?)';
            routedTransaction(
                $ctx,
                static fn () => runGuarded(currentContext($ctx), $insert, ['after-kill'], 'INSERT', self::TBL),
                new TransactionOptions(retryDurationMs: 1),
                $driver,
            );
            $this->assertSame(1, (int) $admin->query('SELECT count(*) FROM ' . self::TBL)->fetchColumn());
            $built->closeAllPools();
        } finally {
            fclose($pipes[0]);
            fclose($pipes[1]);
            proc_terminate($proxy);
            proc_close($proxy);
            $admin->exec('DROP TABLE IF EXISTS ' . self::TBL);
        }
    }

    /**
     * A REAL pg_terminate_backend on the transaction's own connection, with no proxy: the server answers the
     * statement in flight with `FATAL 57P01 terminating connection due to administrator command` and closes
     * the connection — what a restart or a failover sends. That is a connection error
     * ({@see \LiteDbModel\Runtime\isConnectionError()}), so the transaction is retried on a new connection and
     * commits once.
     */
    public function testTransactionRetryAfterAdminShutdownCommitsOnce(): void
    {
        [, $host, $port, $database, $user, $password] = self::dialects()['postgres'];
        $dsn = "pgsql:host=$host;port=$port;dbname=$database";
        $tbl = 'conn_retry_php_admin_shutdown';
        $admin = new \PDO($dsn, $user, $password, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]);
        $admin->exec("DROP TABLE IF EXISTS $tbl");
        $admin->exec("CREATE TABLE $tbl (id serial PRIMARY KEY, label text NOT NULL)");
        try {
            $built = setConfig([new ConnectionSetup(new PdoPoolFactory(), new ConnectionConfig(
                driver: 'postgres',
                host: $host,
                port: $port,
                database: $database,
                user: $user,
                password: $password,
            ))]);
            $ctx = routingContext($built->routing);
            $attempts = 0;
            routedTransaction($ctx, static function () use ($ctx, $tbl, $dsn, $user, $password, &$attempts) {
                $attempts++;
                if ($attempts === 1) {
                    $pid = (int) execute(currentContext($ctx), 'SELECT pg_backend_pid() AS id', [])[0]->id;
                    // Terminate this connection while a statement is in flight on it (from another process:
                    // this one blocks in the statement).
                    $killer = proc_open([PHP_BINARY, '-r', sprintf(
                        'usleep(200000); (new PDO(%s, %s, %s))->query("SELECT pg_terminate_backend(%d)");',
                        var_export($dsn, true),
                        var_export($user, true),
                        var_export($password, true),
                        $pid,
                    )], [], $killerPipes);
                    try {
                        execute(currentContext($ctx), 'SELECT pg_sleep(5)', []);
                    } finally {
                        proc_close($killer);
                    }
                }
                return runGuarded(currentContext($ctx), "INSERT INTO $tbl (label) VALUES (?)", ['after-admin-shutdown'], 'INSERT', $tbl);
            }, new TransactionOptions(retryDurationMs: 1), 'postgres');
            $this->assertSame(2, $attempts);
            $this->assertSame(1, (int) $admin->query("SELECT count(*) FROM $tbl")->fetchColumn());
            $built->closeAllPools();
        } finally {
            $admin->exec("DROP TABLE IF EXISTS $tbl");
        }
    }
}
