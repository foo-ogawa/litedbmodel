<?php

declare(strict_types=1);

namespace LiteDbModel\Runtime\Tests;

use LiteDbModel\Runtime\Dialect;
use LiteDbModel\Runtime\StaticBundle;
use PHPUnit\Framework\TestCase;

/**
 * Render-layer placeholder resolution + dialect NULLS-ordering unit tests.
 *
 * The dialect placeholder render ({@see StaticBundle::renderPlaceholders}) is the render-layer step the
 * leaf transport ({@see \LiteDbModel\Runtime\Leaves}::executeSQL) applies after the dynamic (SKIP)
 * WHERE is assembled; the dialect NULLS ordering is the {@see Dialect} strategy the conformance
 * `dialect` suite pins. The byte-for-byte SQL is otherwise pinned by the frozen vector corpus.
 */
final class RenderTest extends TestCase
{
    public function testPlaceholderRewriteQuoteAware(): void
    {
        // A `?` inside a string literal is NOT a placeholder (mirrors TS renderPlaceholders).
        $this->assertSame("SELECT '?' AS q WHERE a = \$1", StaticBundle::renderPlaceholders("SELECT '?' AS q WHERE a = ?", 'postgres'));
        $this->assertSame('a = ? AND b = ?', StaticBundle::renderPlaceholders('a = ? AND b = ?', 'sqlite'));
    }

    /**
     * @dataProvider orderByNullsCases
     */
    public function testOrderByNulls(string $dialect, string $dir, string $nulls, string $expected): void
    {
        $this->assertSame($expected, Dialect::forName($dialect)->orderByNulls('created_at', $dir, $nulls));
    }

    /** @return list<array{string,string,string,string}> */
    public static function orderByNullsCases(): array
    {
        return [
            ['sqlite', 'ASC', 'FIRST', 'created_at ASC NULLS FIRST'],
            ['postgres', 'DESC', 'LAST', 'created_at DESC NULLS LAST'],
            ['mysql', 'ASC', 'FIRST', 'created_at IS NULL DESC, created_at ASC'],
            ['mysql', 'DESC', 'LAST', 'created_at IS NULL ASC, created_at DESC'],
        ];
    }

    public function testUnknownDialectFailsClosed(): void
    {
        $this->expectException(\RuntimeException::class);
        Dialect::forName('oracle')->orderByNulls('c', 'ASC', 'FIRST');
    }
}
