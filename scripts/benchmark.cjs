const assert = require('node:assert/strict');
const { spawnSync, execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const rounds = Number(process.env.BENCH_ROUNDS ?? 5);
assert.ok(Number.isInteger(rounds) && rounds >= 3, 'BENCH_ROUNDS must be an integer >= 3');
const scenarios = ['integer-array', 'varied-scalars', 'object-array', 'mixed-log', 'sparse-text', 'malformed', 'recovery', 'deep-containers', 'comments', 'unicode-strings'];

function makeInput(name) {
    switch (name) {
        case 'integer-array':
            return '[' + '1,'.repeat(1999999) + '1]';
        case 'varied-scalars': {
            const row = JSON.stringify([0, -7, 123456789, 0.25, 300000, true, false, null]).slice(1, -1);
            return '[' + (row + ',').repeat(99999) + row + ']';
        }
        case 'object-array': {
            const row = JSON.stringify({ id: 123, active: true, text: 'sample text '.repeat(8), values: [1, 2, 3] });
            return '[' + (row + ',').repeat(29999) + row + ']';
        }
        case 'mixed-log': {
            const row = JSON.stringify({ id: 123, text: 'sample text '.repeat(8), arguments: '{"x":1,"list":[1,2]}' });
            return ('[INFO] request\n' + row + '\ncompleted\n').repeat(10000);
        }
        case 'sparse-text':
            return 'x'.repeat(4 * 1024 * 1024) + '{"a":1}' + 'y'.repeat(4 * 1024 * 1024);
        case 'malformed':
            return '{ x "\n'.repeat(5000) + '{"a":1}';
        case 'recovery':
            return '['.repeat(5000) + '1';
        case 'deep-containers':
            return '['.repeat(80) + JSON.stringify('long paragraph '.repeat(200000)) + ']'.repeat(80);
        case 'comments':
            return ('{"id":1,// note\n"list":[1,2,],}\n').repeat(5000);
        case 'unicode-strings':
            return JSON.stringify({ text: '汉字🙂 lorem ipsum\n'.repeat(100000) });
        default:
            throw new Error(`Unknown benchmark scenario: ${name}`);
    }
}

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const directory = mkdtempSync(path.join(tmpdir(), 'jsonformatter-benchmark-'));
try {
    const source = execFileSync('git', ['show', 'HEAD:src/jsonFormatter.ts'], { cwd: root, encoding: 'utf8' });
    const baseline = path.join(directory, 'head.cjs');
    writeFileSync(baseline, ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
    }).outputText);
    const modules = { HEAD: baseline, current: path.join(root, 'out', 'jsonFormatter.js') };
    const comparisons = [];
    for (const heap of [null, 256]) {
        for (const scenario of scenarios) {
            const samples = { HEAD: [], current: [] };
            let expectedHash;
            for (let round = 0; round < rounds; round++) {
                // Alternate ordering to reduce systematic machine-load and thermal bias.
                for (const name of round % 2 ? ['current', 'HEAD'] : ['HEAD', 'current']) {
                    const args = heap === null ? [] : [`--max-old-space-size=${heap}`];
                    args.push('-e', `
                        const { performance } = require('node:perf_hooks');
                        const { createHash } = require('node:crypto');
                        const { JsonFormatter } = require(${JSON.stringify(modules[name])});
                        const input = (${makeInput.toString()})(${JSON.stringify(scenario)});
                        const formatter = new JsonFormatter();
                        const cpu = process.cpuUsage();
                        const start = performance.now();
                        const output = formatter.format(input);
                        const wallMs = performance.now() - start;
                        const elapsedCpu = process.cpuUsage(cpu);
                        const rssMiB = process.resourceUsage().maxRSS / 1024;
                        const hash = createHash('sha256').update(output).digest('hex');
                        console.log(JSON.stringify({ wallMs, cpuMs: (elapsedCpu.user + elapsedCpu.system) / 1000, rssMiB, hash }));
                    `);
                    const result = spawnSync(process.execPath, args, { cwd: root, timeout: 60000, encoding: 'utf8' });
                    assert.ifError(result.error);
                    assert.equal(result.status, 0, `${name}/${scenario}: ${result.stderr}`);
                    const sample = JSON.parse(result.stdout);
                    expectedHash ??= sample.hash;
                    assert.equal(sample.hash, expectedHash, `${name}/${scenario}: output differs from HEAD`);
                    samples[name].push(sample);
                }
            }
            const headMs = median(samples.HEAD.map(sample => sample.wallMs));
            const currentMs = median(samples.current.map(sample => sample.wallMs));
            const comparison = {
                scenario, heap: heap ?? 'default', rounds,
                headMs: Number(headMs.toFixed(2)), currentMs: Number(currentMs.toFixed(2)),
                speedup: Number((headMs / currentMs).toFixed(2)),
                headCpuMs: median(samples.HEAD.map(sample => sample.cpuMs)),
                currentCpuMs: median(samples.current.map(sample => sample.cpuMs)),
                headRssMiB: Number(median(samples.HEAD.map(sample => sample.rssMiB)).toFixed(2)),
                currentRssMiB: Number(median(samples.current.map(sample => sample.rssMiB)).toFixed(2)),
                faster: currentMs < headMs,
            };
            comparisons.push(comparison);
            console.log(JSON.stringify(comparison));
        }
    }
    assert.ok(comparisons.every(result => result.faster), 'Current implementation must beat HEAD in every benchmark case');
} finally {
    rmSync(directory, { recursive: true, force: true });
}
