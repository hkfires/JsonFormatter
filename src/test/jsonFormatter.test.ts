import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { JsonFormatter } from '../jsonFormatter';

const formatter = new JsonFormatter();

test('formats a standalone JSON object', () => {
    assert.equal(formatter.format('{"a":1,"b":[true,null]}'), '{\n  "a": 1,\n  "b": [\n    true,\n    null\n  ]\n}');
});

test('preserves non-JSON content around segments', () => {
    const input = '=== REQUEST BODY ===\n{"model":"gpt-4"}\n=== HEADERS ===\nContent-Type: application/json';
    const expected = '=== REQUEST BODY ===\n{\n  "model": "gpt-4"\n}\n=== HEADERS ===\nContent-Type: application/json';
    assert.equal(formatter.format(input), expected);
});

test('formats multiple segments in one text', () => {
    assert.equal(formatter.format('data: {"a":1}\ndata: {"b":2}'), 'data: {\n  "a": 1\n}\ndata: {\n  "b": 2\n}');
});

test('leaves text without JSON unchanged', () => {
    const input = 'plain text with no json';
    assert.equal(formatter.format(input), input);
});

test('leaves invalid JSON-like text unchanged', () => {
    const input = '[INFO] started {not json}';
    assert.equal(formatter.format(input), input);
});

test('finds valid JSON nested inside an invalid outer block', () => {
    assert.equal(formatter.format('{ x {"a":1} }'), '{ x {\n  "a": 1\n} }');
});

test('ignores brackets inside strings', () => {
    assert.equal(formatter.format('{"s":"a}b]c"}'), '{\n  "s": "a}b]c"\n}');
});

test('expands JSON nested in string values', () => {
    assert.equal(formatter.format('{"args":"{\\"x\\":1}"}'), '{\n  "args": {\n    "x": 1\n  }\n}');
});

test('removes comments and same-line trailing commas', () => {
    assert.equal(formatter.format('{"a": 1, // note\n"b": [2, ], /* c */ }'), '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}');
});

test('keeps // inside strings during relaxed parsing', () => {
    assert.equal(formatter.format('{"url": "http://x", }'), '{\n  "url": "http://x"\n}');
});
