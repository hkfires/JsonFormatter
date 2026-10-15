import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { JsonFormatter } from '../jsonFormatter';

test('allows 1000 indentation levels', () => {
    const input = '['.repeat(1000) + '0' + ']'.repeat(1000);
    assert.equal(new JsonFormatter().format(input), JSON.stringify(JSON.parse(input), null, 2));
});

test('rejects indentation above 1000 levels for arrays and objects', () => {
    for (const input of [
        '['.repeat(1001) + '0' + ']'.repeat(1001),
        '{"x":'.repeat(1001) + '0' + '}'.repeat(1001),
    ]) {
        assert.throws(() => new JsonFormatter().format(input), RangeError);
    }
});

test('applies the limit to custom spaces and tabs', () => {
    const input = '['.repeat(1001) + '0' + ']'.repeat(1001);
    for (const formatter of [new JsonFormatter(10), new JsonFormatter(2, false)]) {
        assert.throws(() => formatter.format(input), RangeError);
    }
});

test('counts the outer indentation when expanding JSON string values', () => {
    const nested = '['.repeat(1000) + '0' + ']'.repeat(1000);
    const input = JSON.stringify({ args: nested });
    assert.throws(() => new JsonFormatter().format(input), RangeError);
    assert.equal(new JsonFormatter(0).format(input), '{"args":' + nested + '}');
});

test('preserves no-indentation support for 12000 nested containers', () => {
    const input = '['.repeat(12000) + '0' + ']'.repeat(12000);
    assert.equal(new JsonFormatter(0).format(input), input);
});

test('rejects excessive nesting under a 128 MiB heap without terminating the process', () => {
    // An OOM must fail only the child process; assert.throws verifies a catchable error instead.
    const result = spawnSync(process.execPath, ['--max-old-space-size=128', '-e', `
        const assert = require('node:assert/strict');
        const { JsonFormatter } = require(${JSON.stringify(require.resolve('../jsonFormatter'))});
        const input = '['.repeat(12000) + '0' + ']'.repeat(12000);
        assert.throws(() => new JsonFormatter().format(input), RangeError);
        assert.equal(new JsonFormatter(0).format(input), input);
    `], { timeout: 15000, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
});
