import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { JsonFormatter } from '../jsonFormatter';

const formatter = new JsonFormatter();

for (const length of [32755, 32756, 32757, 32758, 32759, 65525, 65526]) {
    test(`preserves UTF-16 units across output chunks at offset ${length}`, () => {
        const value = 'a'.repeat(length) + '😀\ud800文\udfff' + 'z'.repeat(32768);
        const input = '{"s":"' + value + '"}';
        assert.equal(formatter.format(input), '{\n  "s": "' + value + '"\n}');
    });
}

test('rolls back a failed candidate after flushing multiple chunks', () => {
    const broken = '[' + '1,'.repeat(50000) + 'broken\n';
    const input = 'head {"ok":1}\n' + broken + '{"tail":2}';
    assert.equal(formatter.format(input), 'head {\n  "ok": 1\n}\n' + broken + '{\n  "tail": 2\n}');
});

test('rolls back partial nested-string expansion without losing surrounding output', () => {
    const data = { before: 1, args: '[' + '1,'.repeat(20000) + 'broken]', after: 2 };
    assert.equal(formatter.format(JSON.stringify(data)), JSON.stringify(data, null, 2));
});

for (const depth of [64, 65, 66]) {
    test(`validates before rendering at the speculation depth boundary ${depth}`, () => {
        const input = '['.repeat(depth) + '{"n":1}' + ']'.repeat(depth);
        assert.equal(formatter.format(input), JSON.stringify(JSON.parse(input), null, 2));
    });
}

test('preserves indentation for deeply structured JSON decoded from strings', () => {
    const nested = '['.repeat(70) + '1' + ']'.repeat(70);
    assert.equal(formatter.format(JSON.stringify({ args: nested })), JSON.stringify({ args: JSON.parse(nested) }, null, 2));
});

test('handles transitions between scalar runs and containers or encoded strings', () => {
    const input = '[1,2,{"x":3},"[4]",true,null,[],5,6,]';
    assert.equal(formatter.format(input), JSON.stringify([1, 2, { x: 3 }, [4], true, null, [], 5, 6], null, 2));
});

test('expands escaped leading brackets and whitespace in string values', () => {
    const input = String.raw`{"a":"\u007b\"x\":1}","b":"\t[2]","c":"　[3]"}`;
    assert.equal(formatter.format(input), JSON.stringify({ a: { x: 1 }, b: [2], c: [3] }, null, 2));
});

test('bounds rejected output and does not recopy large log prefixes on each failed candidate', () => {
    const result = spawnSync(process.execPath, ['--max-old-space-size=256', '-e', `
        const assert = require('node:assert/strict');
        const { JsonFormatter } = require(${JSON.stringify(require.resolve('../jsonFormatter'))});
        const formatter = new JsonFormatter();
        const invalid = '['.repeat(32) + '1,'.repeat(2000000) + 'broken';
        assert.equal(formatter.format(invalid), invalid);
        const encoded = '{"args":"' + '\\\\u005b'.repeat(20000) + '\\\\u005d'.repeat(20000) + '"';
        assert.equal(formatter.format(encoded), encoded);
        const repeated = ('['.repeat(63) + '1,'.repeat(1000) + 'x\\n').repeat(1000);
        assert.equal(formatter.format(repeated), repeated);
        const prefix = 'text'.repeat(1000000) + '{bad '.repeat(10000);
        assert.equal(formatter.format(prefix + '{"ok":1}'), prefix + '{\\n  "ok": 1\\n}');
    `], { timeout: 30000, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
});
