import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { JsonFormatter } from '../jsonFormatter';

const formatter = new JsonFormatter();

test('preserves number literals without conversion to JavaScript numbers', () => {
    const numbers = [
        '12345678901234567890', '-9007199254740993', '1.0', '-0',
        '1e3', '1E+400', '1e-400', '0.12345678901234567890123456789',
    ];
    assert.equal(formatter.format(`[${numbers.join(',')}]`), `[\n  ${numbers.join(',\n  ')}\n]`);
});

test('preserves duplicate keys, key order and escaped strings', () => {
    const input = String.raw`{"z":1,"a":2,"a":3,"2":4,"1":5,"s":"\u0061\/b"}`;
    assert.equal(formatter.format(input), '{\n  "z": 1,\n  "a": 2,\n  "a": 3,\n  "2": 4,\n  "1": 5,\n  "s": "\\u0061\\/b"\n}');
});

test('preserves large numbers when expanding nested JSON strings', () => {
    const input = JSON.stringify({ args: '{"id":12345678901234567890,"n":1e400,}' });
    assert.equal(formatter.format(input), '{\n  "args": {\n    "id": 12345678901234567890,\n    "n": 1e400\n  }\n}');
});

test('does not remove commas or comment markers from strings during relaxed parsing', () => {
    const value = 'x, ] y, } http://a.b /* note */ "quoted" \\';
    const input = JSON.stringify({ s: value }).replace(/}$/, ', }');
    assert.equal(formatter.format(input), JSON.stringify({ s: value }, null, 2));
});

for (const whitespace of ['\n', '\r\n  ', '\t', '  ', ' /* tail */\n']) {
    test(`handles trailing commas before ${JSON.stringify(whitespace)}`, () => {
        assert.equal(formatter.format(`{"a":[1,${whitespace}],${whitespace}}`), '{\n  "a": [\n    1\n  ]\n}');
    });
}

for (const comment of [
    '/* see http://a.b */',
    '// it\'s "x\n',
    '/* } ] { [ " \\ // */',
    '// } ] { [ " \\ /*\r\n',
    '/* " // */ // more " }\n',
]) {
    test(`ignores comment contents: ${JSON.stringify(comment)}`, () => {
        assert.equal(formatter.format(`{ ${comment} "a":1 }`), '{\n  "a": 1\n}');
    });
}

for (const input of [
    '[1/* comment */2]', '{"a":tru/* comment */e}', '{"a":1e/* comment */2}',
    '{"a":1,,}', '[,]', '{"a" 1}', '{"a":}', '[01]', '[+1]', '[NaN]',
    '[1.]', '[.1]', '[1e]', '[true false]', '{"a":1]', '{"a":1 /* unclosed }',
    String.raw`["\x"]`, String.raw`["\u12G4"]`, String.raw`["\u12"]`,
    String.raw`{"\x":1}`, '["raw\ttab"]', '["raw\u0000null"]', '["end\\', '[/*/]',
]) {
    test(`does not accept malformed JSON: ${input}`, () => {
        assert.equal(formatter.format(input), input);
    });
}

test('handles overlapping and adjacent block comment markers', () => {
    for (const input of ['[/*/ 1 */ 2]', '[/****/2]', '[/*/*/2]', '[/**//**/2]']) {
        assert.equal(formatter.format(input), '[\n  2\n]');
    }
});

test('validates all JSON string escape forms without rewriting them', () => {
    const input = String.raw`["\u0041\"\\\/\b\f\n\r\t"]`;
    assert.equal(formatter.format(input), '[\n  ' + input.slice(1, -1) + '\n]');
});

test('recovers valid JSON inside an unclosed outer container', () => {
    const prefix = '[ '.repeat(20000);
    assert.equal(formatter.format(`${prefix}{"a":1}`), `${prefix}{\n  "a": 1\n}`);
    assert.equal(formatter.format('{ broken\n{"a":1}'), '{ broken\n{\n  "a": 1\n}');
});

test('keeps completed inner containers when the outer container is invalid', () => {
    assert.equal(formatter.format('[{"a":1}, {"b":2} broken]'), '[{\n  "a": 1\n}, {\n  "b": 2\n} broken]');
});

test('recovers after mismatched brackets and unterminated strings', () => {
    assert.equal(formatter.format('[1} next {"a":1}'), '[1} next {\n  "a": 1\n}');
    assert.equal(formatter.format('{"s":"broken\n{"a":1}'), '{"s":"broken\n{\n  "a": 1\n}');
});

for (const prefix of ['exclude=[/*.tmp] ', 'see [//cdn/x.js] ', 'broken=[/* ', '["job ']) {
    test(`recovers JSON hidden in a failed candidate: ${prefix}`, () => {
        assert.equal(formatter.format(prefix + '{"a":1}'), prefix + '{\n  "a": 1\n}');
    });
}

test('only ignores JSON inside comments when the enclosing candidate is valid', () => {
    assert.equal(formatter.format('[/* {"a":1} */ broken]'), '[/* {\n  "a": 1\n} */ broken]');
    assert.equal(formatter.format('[/* {"a":1} */ 2]'), '[\n  2\n]');
});

test('retains the nested-string expansion depth limit', () => {
    for (const depth of [30, 31]) {
        const encoded = JSON.stringify('{"a":1}');
        const input = '['.repeat(depth) + encoded + ']'.repeat(depth);
        const expected = '['.repeat(depth) + (depth === 30 ? '{"a":1}' : encoded) + ']'.repeat(depth);
        assert.equal(new JsonFormatter(0).format(input), expected);
    }
});

test('only expands complete JSON containers in string values, never keys', () => {
    const input = JSON.stringify({ '{"a":1}': 'before {"b":2}', bad: '{broken {"c":3}}' });
    assert.equal(formatter.format(input), JSON.stringify(JSON.parse(input), null, 2));
});

test('expands nested containers while preserving empty containers and scalar strings', () => {
    const input = JSON.stringify({ args: '{"nested":"[1,2]"}', empty: '{ }', scalar: '123', array: '[ ]' });
    assert.equal(formatter.format(input), JSON.stringify({ args: { nested: [1, 2] }, empty: {}, scalar: '123', array: [] }, null, 2));
});

test('treats __proto__ as an ordinary property', () => {
    assert.equal(formatter.format('{"__proto__":"{\\"polluted\\":true}"}'), '{\n  "__proto__": {\n    "polluted": true\n  }\n}');
    assert.equal((Object.prototype as Record<string, unknown>).polluted, undefined);
});

test('supports custom spaces and tab indentation', () => {
    assert.equal(new JsonFormatter(4).format('{"a":[1]}'), '{\n    "a": [\n        1\n    ]\n}');
    assert.equal(new JsonFormatter(2, false).format('{"a":1}'), '{\n\t"a": 1\n}');
});

test('handles deep containers without recursive parsing or rendering', () => {
    const depth = 10000;
    const input = '['.repeat(depth) + '1' + ']'.repeat(depth);
    const output = new JsonFormatter(0).format(input);
    assert.equal(output, input);
});

test('avoids repeated suffix scans on large malformed inputs', () => {
    // A separate process makes the timeout effective even if formatting blocks synchronously.
    const result = spawnSync(process.execPath, ['-e', `
        const assert = require('node:assert/strict');
        const { JsonFormatter } = require(${JSON.stringify(require.resolve('../jsonFormatter'))});
        const formatter = new JsonFormatter();
        for (const input of [
            '{'.repeat(50000), '[ '.repeat(50000), '{ x "\\n'.repeat(50000),
            '[/*'.repeat(50000), '[//'.repeat(50000), '["x '.repeat(50000),
            '[/*'.repeat(5000) + '*/' + '1,'.repeat(5000) + 'invalid]',
        ]) {
            assert.equal(formatter.format(input), input);
        }
        for (const prefix of ['[/*'.repeat(30000), '[//'.repeat(30000)]) {
            assert.equal(formatter.format(prefix + '{"a":1}'), prefix + '{\\n  "a": 1\\n}');
        }
    `], { timeout: 10000, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
});

test('matches standard formatting with randomized comments and trailing commas', () => {
    let seed = 12345;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    const value = (depth: number): unknown => {
        if (depth === 0) {
            return [null, true, false, random() / 100, 'quotes " brackets [ ] { } slash \\ \n'][random() % 5];
        }
        if (random() % 2) {
            return Array.from({ length: random() % 5 }, () => value(depth - 1));
        }
        return { a: value(depth - 1), b: value(depth - 1) };
    };
    for (let i = 0; i < 100; i++) {
        const data = value(4);
        const formatted = formatter.format(JSON.stringify(data));
        assert.equal(formatted, JSON.stringify(data, null, 2));
        assert.equal(formatter.format(formatted), formatted);

        const tokens = JSON.stringify(data).match(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\],:]/g)!;
        const relaxed = tokens.map((token, index) => {
            const trailing = (token === '}' || token === ']') && tokens[index - 1] !== '{' && tokens[index - 1] !== '[' ? ',' : '';
            const comment = index === tokens.length - 1 ? '' : random() % 2 ? ' /* http://x " } ] */ ' : ' // " ] } /*\r\n';
            return trailing + token + comment;
        }).join('');
        assert.equal(formatter.format(relaxed), formatted);
    }
});
