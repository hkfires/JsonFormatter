import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import type * as vscode from 'vscode';

const extensionPath = require.resolve('../extension');
const extensionSource = readFileSync(extensionPath, 'utf8');
const extensionRequire = createRequire(extensionPath);

interface HarnessOptions {
    text?: string;
    eol?: '\n' | '\r\n';
    editResult?: boolean | Promise<boolean>;
    editError?: Error;
}

function createHarness(options: HarnessOptions = {}) {
    const state = {
        text: options.text ?? '',
        editCalls: 0,
        replacements: [] as { start: number; end: number; text: string }[],
        positions: [] as number[],
        messages: [] as { type: 'info' | 'warning' | 'error'; text: string }[],
    };
    let command: (() => Promise<void>) | undefined;
    const api = {
        EndOfLine: { LF: 1, CRLF: 2 },
        Range: class {
            constructor(public start: number, public end: number) {}
        },
        commands: {
            registerCommand(id: string, callback: () => Promise<void>) {
                assert.equal(id, 'jsonSegmentFormatter.format');
                command = callback;
                return { dispose() {} };
            },
        },
        window: {
            activeTextEditor: options.text === undefined ? undefined : {
                document: {
                    eol: options.eol === '\r\n' ? 2 : 1,
                    getText: () => state.text,
                    positionAt(offset: number) {
                        state.positions.push(offset);
                        return offset;
                    },
                },
                async edit(callback: (builder: { replace(range: { start: number; end: number }, text: string): void }) => void) {
                    state.editCalls++;
                    callback({
                        replace(range, text) {
                            state.replacements.push({ start: range.start, end: range.end, text });
                        },
                    });
                    if (options.editError) {
                        throw options.editError;
                    }
                    const applied = await (options.editResult ?? true);
                    if (applied) {
                        state.text = state.replacements[state.replacements.length - 1].text;
                    }
                    return applied;
                },
            },
            showInformationMessage(text: string) {
                state.messages.push({ type: 'info', text });
            },
            showWarningMessage(text: string) {
                state.messages.push({ type: 'warning', text });
            },
            showErrorMessage(text: string) {
                state.messages.push({ type: 'error', text });
            },
        },
    };

    // Load the real compiled command with an isolated VS Code mock, without patching module loading globally.
    const module = { exports: {} as typeof import('../extension') };
    runInNewContext(extensionSource, {
        module,
        exports: module.exports,
        require: (id: string) => id === 'vscode' ? api : extensionRequire(id),
        console,
        Error,
    }, { filename: extensionPath });
    const subscriptions: vscode.Disposable[] = [];
    module.exports.activate({ subscriptions } as vscode.ExtensionContext);
    assert.equal(subscriptions.length, 1);
    assert.ok(command);
    return { state, run: command };
}

for (const [name, text, eol] of [
    ['plain text', 'plain text without JSON', '\n'],
    ['empty document', '', '\n'],
    ['formatted JSON', '{\n  "a": 1\n}', '\n'],
    ['formatted CRLF JSON', '{\r\n  "a": 1\r\n}', '\r\n'],
] as const) {
    test(`skips edits for ${name}`, async () => {
        const { state, run } = createHarness({ text, eol });
        await run();
        assert.equal(state.editCalls, 0);
        assert.deepEqual(state.positions, []);
        assert.deepEqual(state.replacements, []);
        assert.equal(state.text, text);
        assert.deepEqual(state.messages, [{ type: 'info', text: '内容无需更改' }]);
    });
}

test('reports failed edits without reporting success', async () => {
    const input = '{"a":1}';
    const { state, run } = createHarness({ text: input, editResult: false });
    await run();
    assert.equal(state.editCalls, 1);
    assert.equal(state.text, input);
    assert.deepEqual(state.messages, [{ type: 'error', text: '格式化失败: 编辑器未应用更改' }]);
});

test('applies changed content once and skips the next unchanged invocation', async () => {
    const input = '{"a":1}';
    const { state, run } = createHarness({ text: input });
    await run();
    assert.equal(state.editCalls, 1);
    assert.deepEqual(state.replacements, [{ start: 0, end: input.length, text: '{\n  "a": 1\n}' }]);
    assert.equal(state.text, '{\n  "a": 1\n}');
    assert.deepEqual(state.messages, [{ type: 'info', text: 'JSON 格式化完成' }]);
    await run();
    assert.equal(state.editCalls, 1);
    assert.deepEqual(state.messages[1], { type: 'info', text: '内容无需更改' });
});

test('preserves document line endings when applying changes', async () => {
    const { state, run } = createHarness({ text: 'header\r\n{"a":1}\r\n', eol: '\r\n' });
    await run();
    assert.equal(state.text, 'header\r\n{\r\n  "a": 1\r\n}\r\n');
    await run();
    assert.equal(state.editCalls, 1);
});

test('waits for edit confirmation before reporting success', async () => {
    let confirm!: (applied: boolean) => void;
    const editResult = new Promise<boolean>(resolve => { confirm = resolve; });
    const { state, run } = createHarness({ text: '{"a":1}', editResult });
    const pending = run();
    assert.deepEqual(state.messages, []);
    confirm(true);
    await pending;
    assert.deepEqual(state.messages, [{ type: 'info', text: 'JSON 格式化完成' }]);
});

test('reports rejected edits through the existing error handler', async () => {
    const { state, run } = createHarness({ text: '{"a":1}', editError: new Error('edit rejected') });
    await run();
    assert.equal(state.editCalls, 1);
    assert.equal(state.text, '{"a":1}');
    assert.deepEqual(state.messages, [{ type: 'error', text: '格式化失败: edit rejected' }]);
});

test('reports excessive nesting without modifying any part of the document', async () => {
    const input = 'head {"ok":1}\n' + '['.repeat(1001) + '0' + ']'.repeat(1001);
    const { state, run } = createHarness({ text: input });
    await run();
    assert.equal(state.editCalls, 0);
    assert.deepEqual(state.positions, []);
    assert.deepEqual(state.replacements, []);
    assert.equal(state.text, input);
    assert.deepEqual(state.messages, [{ type: 'error', text: '格式化失败: JSON 嵌套超过 1000 层，已停止格式化' }]);
});

test('keeps the warning when there is no active editor', async () => {
    const { state, run } = createHarness();
    await run();
    assert.equal(state.editCalls, 0);
    assert.deepEqual(state.messages, [{ type: 'warning', text: '没有打开的文件' }]);
});
