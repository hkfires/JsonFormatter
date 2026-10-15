import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('formats a two-million-element array within a 256 MB heap', () => {
    // Isolate the memory limit: an OOM must fail the child, not terminate the test runner.
    const result = spawnSync(process.execPath, ['--max-old-space-size=256', '-e', `
        const assert = require('node:assert/strict');
        const { createHash } = require('node:crypto');
        const { JsonFormatter } = require(${JSON.stringify(require.resolve('../jsonFormatter'))});
        const input = '[' + '1,'.repeat(1999999) + '1]';
        const output = new JsonFormatter().format(input);
        const expected = '[\\n  ' + '1,\\n  '.repeat(1999999) + '1\\n]';
        assert.equal(output.length, expected.length);
        assert.equal(
            createHash('sha256').update(output).digest('hex'),
            createHash('sha256').update(expected).digest('hex')
        );
        // The heap limit does not include ArrayBuffers, so also bound peak process memory.
        assert.ok(process.resourceUsage().maxRSS <= 320 * 1024, 'Peak RSS exceeded 320 MiB');
        assert.ok(process.memoryUsage().arrayBuffers <= 128 * 1024 * 1024, 'ArrayBuffers exceeded 128 MiB');
    `], { timeout: 30000, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
});

test('allocates parser caches sparsely in mostly non-JSON documents', () => {
    const result = spawnSync(process.execPath, ['--max-old-space-size=256', '-e', `
        const assert = require('node:assert/strict');
        const { JsonFormatter } = require(${JSON.stringify(require.resolve('../jsonFormatter'))});
        const NativeInt32Array = Int32Array;
        const initialBuffers = process.memoryUsage().arrayBuffers;
        let peakBuffers = 0;
        // Sampling allocation sites captures external-memory peaks even if GC frees them later.
        // This override is confined to the test child process.
        global.Int32Array = class extends NativeInt32Array {
            constructor(length) {
                super(length);
                peakBuffers = Math.max(peakBuffers, process.memoryUsage().arrayBuffers - initialBuffers);
            }
        };
        const prefix = '[/*' + 'x'.repeat(4 * 1024 * 1024);
        const suffix = 'y'.repeat(4 * 1024 * 1024);
        const input = prefix + '{\"a\":1}' + suffix;
        const output = new JsonFormatter().format(input);
        assert.equal(output, prefix + '{\\n  \"a\": 1\\n}' + suffix);
        // Two lexical tables cost eight bytes per character; sparse caches should add little.
        assert.ok(peakBuffers <= input.length * 9, 'Sparse input allocated dense parser caches');
    `], { timeout: 30000, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
});

test('bounds memory for wide objects and arrays of containers', () => {
    const result = spawnSync(process.execPath, ['--max-old-space-size=256', '-e', `
        const assert = require('node:assert/strict');
        const { createHash } = require('node:crypto');
        const { JsonFormatter } = require(${JSON.stringify(require.resolve('../jsonFormatter'))});
        const formatter = new JsonFormatter();
        for (const [input, expected] of [
            ['{' + '\"id\":12345678901234567890,'.repeat(199999) + '\"id\":1}',
             '{\\n  ' + '\"id\": 12345678901234567890,\\n  '.repeat(199999) + '\"id\": 1\\n}'],
            ['[' + '[1],'.repeat(199999) + '[1]]',
             '[\\n  ' + '[\\n    1\\n  ],\\n  '.repeat(199999) + '[\\n    1\\n  ]\\n]'],
        ]) {
            const output = formatter.format(input);
            assert.equal(output.length, expected.length);
            assert.equal(
                createHash('sha256').update(output).digest('hex'),
                createHash('sha256').update(expected).digest('hex')
            );
        }
    `], { timeout: 30000, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
});
