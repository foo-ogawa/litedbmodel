<?php

declare(strict_types=1);

namespace LiteDbModel\Runtime\Tests;

/**
 * A loopback TCP proxy for the live retry tests ({@see ConnRetryLiveTest}), run as its own process because a
 * PHP test cannot serve sockets while it blocks in PDO:
 *
 *     php StaleProxy.php <upstream-host> <upstream-port>
 *
 * Prints the port it listens on, then forwards every connection to the upstream. A line `stale` on stdin
 * turns every connection open at that moment into a dead one the client cannot see: nothing more is
 * forwarded to the client (not the server's goodbye either), and the client's next write closes its socket
 * — the connection error a pool meets on a connection that died under it behind a load balancer or a
 * failover. Connections opened later are forwarded normally. It answers each `stale` with `ok`.
 */
final class StaleProxy
{
    /** @param list<string> $argv */
    public static function main(array $argv): void
    {
        [$_, $host, $port] = $argv;
        $server = stream_socket_server('tcp://127.0.0.1:0', $errno, $errstr);
        if ($server === false) {
            fwrite(STDERR, "listen: $errstr\n");
            exit(1);
        }
        $name = stream_socket_get_name($server, false);
        echo substr($name, strrpos($name, ':') + 1), "\n";

        /** @var array<int, array{client: resource, upstream: resource|null, dead: bool}> $pairs */
        $pairs = [];

        $close = static function (int $id) use (&$pairs): void {
            fclose($pairs[$id]['client']);
            if ($pairs[$id]['upstream'] !== null) {
                fclose($pairs[$id]['upstream']);
            }
            unset($pairs[$id]);
        };

        while (true) {
            $read = [STDIN, $server];
            foreach ($pairs as $pair) {
                $read[] = $pair['client'];
                if ($pair['upstream'] !== null) {
                    $read[] = $pair['upstream'];
                }
            }
            $write = $except = null;
            if (stream_select($read, $write, $except, null) === false) {
                exit(1);
            }
            foreach ($read as $stream) {
                if ($stream === STDIN) {
                    $line = fgets(STDIN);
                    if ($line === false) {
                        exit(0); // the test ended
                    }
                    if (trim($line) === 'stale') {
                        foreach ($pairs as $id => $pair) {
                            $pairs[$id]['dead'] = true;
                        }
                        echo "ok\n";
                    }
                    continue;
                }
                if ($stream === $server) {
                    $client = stream_socket_accept($server);
                    $upstream = stream_socket_client("tcp://$host:$port", $errno, $errstr);
                    if ($client !== false && $upstream !== false) {
                        $pairs[(int) $client] = ['client' => $client, 'upstream' => $upstream, 'dead' => false];
                    } elseif ($client !== false) {
                        fclose($client); // the upstream is unreachable: the client sees the connection refused
                    }
                    continue;
                }
                foreach ($pairs as $id => $pair) {
                    if ($stream === $pair['client']) {
                        $data = fread($stream, 65536);
                        if ($data === '' || $data === false || $pair['dead']) {
                            $close($id); // a write on a dead connection closes it
                        } else {
                            fwrite($pair['upstream'], $data);
                        }
                        break;
                    }
                    if ($stream === $pair['upstream']) {
                        $data = fread($stream, 65536);
                        if ($pair['dead']) {
                            if ($data === '' || $data === false) {
                                fclose($pair['upstream']); // the server is gone; the client is not told
                                $pairs[$id]['upstream'] = null;
                            }
                        } elseif ($data === '' || $data === false) {
                            $close($id);
                        } else {
                            fwrite($pair['client'], $data);
                        }
                        break;
                    }
                }
            }
        }
    }
}

// Run only when executed as a script (`php StaleProxy.php …`), never when the file is merely loaded.
if (PHP_SAPI === 'cli' && isset($argv[0]) && realpath($argv[0]) === __FILE__) {
    StaleProxy::main($argv);
}
