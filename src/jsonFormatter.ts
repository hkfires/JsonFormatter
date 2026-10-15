import { endianness } from 'node:os';

const littleEndian = endianness() === 'LE';

interface ScanResult {
    end: number;
    rendered: boolean;
}

interface JsonSegment {
    start: number;
    end: number;
}

type ParseTask = { kind: 'container'; start: number } | {
    kind: 'object' | 'array';
    start: number;
    pending: number;
};

/** Allocate 4096-offset cache pages only where parsing visits, not across mostly plain-text logs. */
class OffsetCache {
    private readonly pages = new Map<number, Int32Array>();
    private pageIndex = -1;
    private page: Int32Array | undefined;

    public get(offset: number): number {
        const index = offset >>> 12;
        if (index !== this.pageIndex) {
            this.pageIndex = index;
            this.page = this.pages.get(index);
        }
        return this.page?.[offset & 4095] ?? 0;
    }

    public set(offset: number, value: number): void {
        const index = offset >>> 12;
        if (index !== this.pageIndex) {
            this.pageIndex = index;
            this.page = this.pages.get(index);
        }
        if (!this.page) {
            this.page = new Int32Array(4096);
            this.pages.set(index, this.page);
        }
        this.page[offset & 4095] = value;
    }
}

/** A bounded UTF-16 writer avoids millions of temporary strings and preserves lone surrogates. */
class TextWriter {
    private readonly buffer = Buffer.allocUnsafe(65536);
    private readonly units = new Uint16Array(this.buffer.buffer, this.buffer.byteOffset, this.buffer.length / 2);
    private readonly chunks: string[] = [];
    private used = 0;
    // Monotonic work counter includes discarded speculative output.
    public written = 0;

    public write(text: string, start: number = 0, end: number = text.length): void {
        this.written += end - start;
        while (start < end) {
            const length = Math.min(end - start, (this.buffer.length - this.used) / 2);
            if (length > 256) {
                this.buffer.write(text.slice(start, start + length), this.used, length * 2, 'utf16le');
                this.used += length * 2;
                start += length;
            } else {
                const stop = start + length;
                if (littleEndian) {
                    let index = this.used / 2;
                    while (start < stop) this.units[index++] = text.charCodeAt(start++);
                    this.used = index * 2;
                } else {
                    while (start < stop) {
                        const code = text.charCodeAt(start++);
                        this.buffer[this.used++] = code & 255;
                        this.buffer[this.used++] = code >>> 8;
                    }
                }
            }
            if (this.used === this.buffer.length) {
                this.chunks.push(this.buffer.toString('utf16le'));
                this.used = 0;
            }
        }
    }

    public writeToken(prefix: string, text: string, start: number, end: number): void {
        const length = prefix.length + end - start;
        if (littleEndian && this.used + length * 2 <= this.buffer.length) {
            this.written += length;
            let index = this.used / 2;
            for (let i = 0; i < prefix.length; i++) this.units[index++] = prefix.charCodeAt(i);
            while (start < end) this.units[index++] = text.charCodeAt(start++);
            this.used = index * 2;
        } else {
            this.write(prefix);
            this.write(text, start, end);
        }
    }

    public checkpoint(): number {
        if (this.used > 0) {
            this.chunks.push(this.buffer.toString('utf16le', 0, this.used));
            this.used = 0;
        }
        return this.chunks.length;
    }

    public rollback(checkpoint: number): void {
        this.chunks.length = checkpoint;
        this.used = 0;
    }

    public commitPrefix(checkpoint: number, prefix: string): void {
        // Delay copying surrounding text until the candidate succeeds; rejected candidates
        // must not repeatedly copy the same potentially large non-JSON prefix.
        if (prefix) this.chunks.splice(checkpoint, 0, prefix);
    }

    public appendUnchanged(text: string, start: number, end: number = text.length): void {
        if (start < end) {
            this.checkpoint();
            this.chunks.push(text.slice(start, end));
        }
    }

    public finish(): string {
        if (this.used > 0) {
            this.chunks.push(this.buffer.toString('utf16le', 0, this.used));
            this.used = 0;
        }
        return this.chunks.join('');
    }
}

export class JsonFormatter {
    private readonly indent: string;
    private readonly stringSpecial = /["\\\u0000-\u001f]/g;

    constructor(indentSize: number = 2, useSpaces: boolean = true) {
        this.indent = (useSpaces ? ' '.repeat(indentSize) : '\t').slice(0, 10);
    }

    public format(text: string): string {
        const openings = /[\[{]/g;
        if (!openings.test(text)) {
            return text;
        }
        const writer = new TextWriter();
        let cursor = 0;
        let failedWork = 0;
        do {
            const start = openings.lastIndex - 1;
            const checkpoint = writer.checkpoint();
            const writtenBefore = writer.written;
            const { end, rendered } = this.scanContainer(text, start, writer);
            if (end > 0) {
                if (!rendered) {
                    writer.rollback(checkpoint);
                    this.formatSegment(text, { start, end }, writer);
                }
                writer.commitPrefix(checkpoint, text.slice(cursor, start));
                cursor = end;
                openings.lastIndex = end;
            } else {
                writer.rollback(checkpoint);
                failedWork += -end - start + writer.written - writtenBefore;
                // Invalid candidates are normal in logs, not exceptions. Bound retries before
                // switching to memoized recognition, which can recover overlapping candidates.
                if (failedWork >= Math.max(4096, text.length)) {
                    const remaining = text.slice(cursor);
                    const segments = this.parseText(remaining);
                    if (cursor === 0 && segments.length === 0) {
                        return text;
                    }
                    let offset = 0;
                    for (const segment of segments) {
                        writer.appendUnchanged(remaining, offset, segment.start);
                        this.formatSegment(remaining, segment, writer);
                        offset = segment.end;
                    }
                    writer.appendUnchanged(remaining, offset);
                    return writer.finish();
                }
            }
        } while (openings.test(text));
        if (cursor === 0) {
            return text;
        }
        writer.appendUnchanged(text, cursor);
        return writer.finish();
    }

    private skipTrivia(text: string, start: number): number {
        let i = start;
        while (i < text.length) {
            const code = text.charCodeAt(i);
            if (code === 32 || code === 9 || code === 10 || code === 13) {
                i++;
            } else if (code === 47 && text.charCodeAt(i + 1) === 47) {
                i += 2;
                while (i < text.length && text.charCodeAt(i) !== 10 && text.charCodeAt(i) !== 13) {
                    i++;
                }
            } else if (code === 47 && text.charCodeAt(i + 1) === 42) {
                const end = text.indexOf('*/', i + 2);
                if (end === -1) {
                    return text.length;
                }
                i = end + 2;
            } else {
                break;
            }
        }
        return i;
    }

    /** Return the token end, or -(examined offset + 1) for an invalid token. */
    private scanString(text: string, start: number): number {
        const special = this.stringSpecial;
        special.lastIndex = start + 1;
        while (special.test(text)) {
            const i = special.lastIndex - 1;
            const code = text.charCodeAt(i);
            if (code === 34) {
                return i + 1;
            }
            if (code !== 92) {
                return -(i + 1);
            }
            const escape = text[i + 1];
            if (escape === 'u' && /^[\da-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
                special.lastIndex = i + 6;
            } else if (i + 1 < text.length && '"\\/bfnrt'.includes(escape)) {
                special.lastIndex = i + 2;
            } else {
                return -(Math.min(i + 2, text.length) + 1);
            }
        }
        return -(text.length + 1);
    }

    private scanNumber(text: string, start: number): number {
        let i = start;
        let code = text.charCodeAt(i);
        if (code === 45) code = text.charCodeAt(++i);
        if (code === 48) {
            code = text.charCodeAt(++i);
        } else {
            if (!(code >= 49 && code <= 57)) return -(i + 1);
            do { code = text.charCodeAt(++i); } while (code >= 48 && code <= 57);
        }
        if (code === 46) {
            code = text.charCodeAt(++i);
            if (!(code >= 48 && code <= 57)) return -(i + 1);
            do { code = text.charCodeAt(++i); } while (code >= 48 && code <= 57);
        }
        if (code === 101 || code === 69) {
            code = text.charCodeAt(++i);
            if (code === 43 || code === 45) code = text.charCodeAt(++i);
            if (!(code >= 48 && code <= 57)) return -(i + 1);
            do { code = text.charCodeAt(++i); } while (code >= 48 && code <= 57);
        }
        return i;
    }

    /** Batch scalar array entries without revisiting the general container state machine. */
    private writeScalarRun(text: string, start: number, writer: TextWriter, prefix: string, separator: string, outputLimit: number): number {
        let i = start;
        while (true) {
            const char = text[i];
            let end: number;
            if (char === '-' || (char >= '0' && char <= '9')) {
                end = this.scanNumber(text, i);
                if (end < 0) return end;
            } else if (text.startsWith('true', i) || text.startsWith('null', i)) {
                end = i + 4;
            } else if (text.startsWith('false', i)) {
                end = i + 5;
            } else {
                return -(i + 1);
            }
            writer.writeToken(prefix, text, i, end);
            if (writer.written >= outputLimit) return end;
            let next = end;
            if (text.charCodeAt(next) <= 32 || text[next] === '/') next = this.skipTrivia(text, next);
            if (text[next] !== ',') return end;
            next++;
            if (text.charCodeAt(next) <= 32 || text[next] === '/') next = this.skipTrivia(text, next);
            const first = text[next];
            if (first !== '-' && first !== 't' && first !== 'f' && first !== 'n' && !(first >= '0' && first <= '9')) {
                return end;
            }
            prefix = separator;
            i = next;
        }
    }

    /** Validate and render ordinary candidates together, without token caches or a second scan. */
    private scanContainer(text: string, start: number, writer: TextWriter, baseDepth: number = 0, visitOffset: number = 0): ScanResult {
        // Object: 0 = key/end, 2 = value, 3 = comma/end. Array: 4 = value/end, 5 = comma/end.
        // Bit 8 defers a comma until the next entry, so trailing commas produce no output.
        const states = [text[start] === '{' ? 0 : 4];
        const newline = this.indent ? '\n' : '';
        const lines: string[] = [];
        const commas: string[] = [];
        lines[baseDepth] = newline + this.indent.repeat(baseDepth);
        let output: TextWriter | undefined = writer;
        const outputLimit = writer.written + Math.max(65536, (text.length - start) * 8);
        let rendered = true;
        writer.write(text, start, start + 1);
        let i = start + 1;
        while (states.length > 0) {
            if (output && writer.written >= outputLimit) {
                output = undefined;
                rendered = false;
            }
            if (text.charCodeAt(i) <= 32 || text[i] === '/') i = this.skipTrivia(text, i);
            if (i >= text.length) return { end: -(i + 1), rendered };
            const last = states.length - 1;
            let rawState = states[last];
            let state = rawState & 7;
            const depth = baseDepth + states.length;
            let char = text[i];
            if (state === 3 || state === 5) {
                if (char === ',') {
                    rawState = (state === 3 ? 0 : 4) | 8;
                    state = rawState & 7;
                    i++;
                    if (text.charCodeAt(i) <= 32 || text[i] === '/') i = this.skipTrivia(text, i);
                    if (i >= text.length) return { end: -(i + 1), rendered };
                    char = text[i];
                } else if (char !== '}' && char !== ']') {
                    return { end: -(i + 1), rendered };
                }
            }
            if (char === '}' || char === ']') {
                if ((char === '}' && state !== 0 && state !== 3) || (char === ']' && state !== 4 && state !== 5)) {
                    return { end: -(i + 1), rendered };
                }
                if (output) {
                    if (state === 3 || state === 5 || (rawState & 8)) output.write(lines[depth - 1]);
                    output.write(char);
                }
                states.pop();
                i++;
            } else {
                if (output && (state === 0 || state === 4)) {
                    if (lines[depth] === undefined) {
                        lines[depth] = newline + this.indent.repeat(depth);
                        commas[depth] = ',' + lines[depth];
                    }
                    const prefix = rawState & 8 ? commas[depth] : lines[depth];
                    if (state === 4 && (char === '-' || char === 't' || char === 'f' || char === 'n' || (char >= '0' && char <= '9'))) {
                        i = this.writeScalarRun(text, i, output, prefix, commas[depth], outputLimit);
                        if (i < 0) return { end: i, rendered };
                        states[last] = 5;
                        continue;
                    }
                    output.write(prefix);
                }
                const valueStart = i;
                if (state === 0) {
                    if (char !== '"') return { end: -(i + 1), rendered };
                    i = this.scanString(text, i);
                    if (i < 0) return { end: i, rendered };
                    output?.write(text, valueStart, i);
                    if (text.charCodeAt(i) <= 32 || text[i] === '/') i = this.skipTrivia(text, i);
                    if (text[i] !== ':') return { end: -(i + 1), rendered };
                    output?.write(this.indent ? ': ' : ':');
                    states[last] = 2;
                    i++;
                } else {
                    states[last] = state === 2 ? 3 : 5;
                    if (char === '{' || char === '[') {
                        output?.write(char);
                        states.push(char === '{' ? 0 : 4);
                        i++;
                        // Do not speculate quadratically growing indentation for unclosed input.
                        // Deep candidates are validated first, then rendered only on success.
                        if (baseDepth + states.length > 64) {
                            output = undefined;
                            rendered = false;
                        }
                    } else {
                        if (char === '"') {
                            i = this.scanString(text, i);
                        } else if (char === '-' || (char >= '0' && char <= '9')) {
                            i = this.scanNumber(text, i);
                        } else if (text.startsWith('true', i) || text.startsWith('null', i)) {
                            i += 4;
                        } else if (text.startsWith('false', i)) {
                            i += 5;
                        } else {
                            return { end: -(i + 1), rendered };
                        }
                        if (i < 0) return { end: i, rendered };
                        if (output) {
                            if (char === '"') {
                                if (!this.writeStringValue(text, valueStart, i, output, depth, visitOffset, true)) {
                                    output = undefined;
                                    rendered = false;
                                }
                            } else {
                                output.write(text, valueStart, i);
                            }
                        }
                    }
                }
            }
        }
        return { end: i, rendered };
    }

    /** False means nested output must wait until the outer candidate has been validated. */
    private writeStringValue(text: string, start: number, end: number, writer: TextWriter, depth: number, visitOffset: number, speculative: boolean): boolean {
        if (depth + visitOffset <= 30) {
            const preview = text.slice(start + 1, end - 1).trim();
            // Escaped leading characters may decode to whitespace or opening brackets.
            if (preview[0] === '{' || preview[0] === '[' || preview[0] === '\\') {
                // The outer string is validated. Unexpected decoding errors must propagate.
                const decoded = (JSON.parse(text.slice(start, end)) as string).trim();
                if ((decoded.startsWith('{') && decoded.endsWith('}'))
                    || (decoded.startsWith('[') && decoded.endsWith(']'))) {
                    const checkpoint = writer.checkpoint();
                    const result = this.scanContainer(decoded, 0, writer, depth, visitOffset + 1);
                    if (result.end === decoded.length) {
                        if (!result.rendered) {
                            writer.rollback(checkpoint);
                            // Never render unbounded nested output before the outer candidate succeeds.
                            if (speculative) return false;
                            this.formatSegment(decoded, { start: 0, end: decoded.length }, writer, depth, visitOffset + 1);
                        }
                        return true;
                    }
                    writer.rollback(checkpoint);
                }
            }
        }
        writer.write(text, start, end);
        return true;
    }

    /**
     * Precompute trivia skips and valid string ends in linear time. A failed candidate
     * may expose starts inside its strings/comments, so lexical lookups must also be
     * constant-time when these spans overlap. String-body transitions need six lookahead
     * positions at most (a Unicode escape), allowing a seven-slot rolling table.
     */
    private scanTokens(text: string): { next: Int32Array; strings: Int32Array } {
        const next = new Int32Array(text.length + 1);
        next[text.length] = text.length;
        // Zero denotes a non-quote; -1 denotes an invalid string start.
        const strings = new Int32Array(text.length);
        const bodies = new Array<number>(7).fill(-1);
        let lineEnd = text.length;
        let blockClose = -1;
        let followingBlockClose = -1;

        for (let i = text.length - 1; i >= 0; i--) {
            const char = text[i];
            if (char === '\n' || char === '\r') {
                lineEnd = i;
            }
            if (char === '*' && text[i + 1] === '/') {
                followingBlockClose = blockClose;
                blockClose = i;
            }

            if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
                next[i] = next[i + 1];
            } else if (char === '/' && text[i + 1] === '/') {
                next[i] = next[lineEnd];
            } else if (char === '/' && text[i + 1] === '*') {
                // The closing marker cannot overlap the opening marker in /*/.
                const close = blockClose === i + 1 ? followingBlockClose : blockClose;
                next[i] = close === -1 ? -1 : next[close + 2];
            } else {
                next[i] = i;
            }

            if (char === '"') {
                strings[i] = bodies[(i + 1) % 7];
                bodies[i % 7] = i + 1;
            } else if (char < '\u0020') {
                bodies[i % 7] = -1;
            } else if (char === '\\') {
                if (text[i + 1] === 'u' && /^[\da-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
                    bodies[i % 7] = bodies[(i + 6) % 7];
                } else if (i + 1 < text.length && '"\\/bfnrt'.includes(text[i + 1])) {
                    bodies[i % 7] = bodies[(i + 2) % 7];
                } else {
                    bodies[i % 7] = -1;
                }
            } else {
                bodies[i % 7] = bodies[(i + 1) % 7];
            }
        }
        return { next, strings };
    }

    /**
     * Cache only end offsets, not an object tree or per-element Map entries.
     * Zero means unknown, -1 means a non-JSON candidate, and positive values are ends.
     * Entry suffixes temporarily encode backward links as -(previous + 3), with -2
     * terminating a chain. Resolving a suffix fills that chain without a task per sibling.
     * Tasks therefore grow with container depth, not array/object width.
     * Non-JSON candidates are expected in mixed logs; only validated spans are rendered.
     */
    private parseText(text: string): JsonSegment[] {
        const segments: JsonSegment[] = [];
        const { next, strings } = this.scanTokens(text);
        const values = new OffsetCache();
        const objects = new OffsetCache();
        const arrays = new OffsetCache();
        const primitive = /(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/y;
        let i = 0;

        while (i < text.length) {
            if (text[i] !== '{' && text[i] !== '[') {
                i++;
                continue;
            }

            const tasks: ParseTask[] = values.get(i) === 0 ? [{ kind: 'container', start: i }] : [];
            while (tasks.length > 0) {
                const task = tasks[tasks.length - 1];
                const { start, kind } = task;
                if (kind === 'container') {
                    const containerKind = text[start] === '{' ? 'object' : 'array';
                    const cache = containerKind === 'object' ? objects : arrays;
                    const entryStart = next[start + 1];
                    if (entryStart < 0) {
                        values.set(start, -1);
                    } else if (cache.get(entryStart) === 0) {
                        tasks.push({ kind: containerKind, start: entryStart, pending: -1 });
                        continue;
                    } else {
                        values.set(start, cache.get(entryStart));
                    }
                    tasks.pop();
                    continue;
                }

                const cache = kind === 'object' ? objects : arrays;
                const close = kind === 'object' ? '}' : ']';
                let end = cache.get(start);
                if (end === 0) {
                    end = -1;
                    if (text[start] === close) {
                        end = start + 1;
                    } else {
                        let valueStart = kind === 'array' ? start : -1;
                        if (kind === 'object') {
                            const keyEnd = strings[start];
                            const colon = keyEnd > 0 ? next[keyEnd] : -1;
                            if (colon >= 0 && text[colon] === ':') {
                                valueStart = next[colon + 1];
                            }
                        }
                        if (valueStart >= 0 && valueStart < text.length) {
                            if (values.get(valueStart) === 0) {
                                const char = text[valueStart];
                                if (char === '{' || char === '[') {
                                    tasks.push({ kind: 'container', start: valueStart });
                                    continue;
                                }
                                if (char === '"') {
                                    values.set(valueStart, strings[valueStart]);
                                } else {
                                    primitive.lastIndex = valueStart;
                                    values.set(valueStart, primitive.test(text) ? primitive.lastIndex : -1);
                                }
                            }
                            const valueEnd = values.get(valueStart);
                            const separator = valueEnd > 0 ? next[valueEnd] : -1;
                            if (separator >= 0 && text[separator] === close) {
                                end = separator + 1;
                            } else if (separator >= 0 && text[separator] === ',') {
                                const tailStart = next[separator + 1];
                                if (tailStart >= 0) {
                                    cache.set(start, -(task.pending + 3));
                                    task.pending = start;
                                    task.start = tailStart;
                                    continue;
                                }
                            }
                        }
                    }
                }

                cache.set(start, end);
                let pending = task.pending;
                while (pending >= 0) {
                    const previous = -cache.get(pending) - 3;
                    cache.set(pending, end);
                    pending = previous;
                }
                tasks.pop();
            }

            const end = values.get(i);
            if (end > 0) {
                segments.push({ start: i, end });
                i = end;
            } else {
                i++;
            }
        }
        return segments;
    }

    /** Render validated spans without per-element nodes, caches, or string allocations. */
    private formatSegment(text: string, segment: JsonSegment, writer: TextWriter, depth: number = 0, visitOffset: number = 0): void {
        let cursor = segment.start;
        const newline = this.indent ? '\n' : '';
        const lines: string[] = [];
        const commas: string[] = [];
        lines[depth] = newline + this.indent.repeat(depth);
        commas[depth] = ',' + lines[depth];

        while (cursor < segment.end) {
            const start = text.charCodeAt(cursor) <= 32 || text[cursor] === '/'
                ? this.skipTrivia(text, cursor) : cursor;
            if (start >= segment.end) {
                throw new Error('Invalid token position in a validated JSON segment');
            }
            const char = text[start];
            if (char === '{' || char === '[') {
                const content = this.skipTrivia(text, start + 1);
                const close = char === '{' ? '}' : ']';
                writer.write(char);
                if (text[content] === close) {
                    writer.write(close);
                    cursor = content + 1;
                } else {
                    depth++;
                    // Stop quadratic indentation growth before allocating deeper padding.
                    if (this.indent && depth > 1000) {
                        throw new RangeError('JSON 嵌套超过 1000 层，已停止格式化');
                    }
                    if (lines[depth] === undefined) {
                        lines[depth] = newline + this.indent.repeat(depth);
                        commas[depth] = ',' + lines[depth];
                    }
                    writer.write(lines[depth]);
                    cursor = content;
                }
                continue;
            }
            if (char === '}' || char === ']') {
                depth--;
                writer.write(lines[depth]);
                writer.write(char);
                cursor = start + 1;
                continue;
            }
            if (char === ',') {
                cursor = start + 1;
                if (text.charCodeAt(cursor) <= 32 || text[cursor] === '/') {
                    cursor = this.skipTrivia(text, cursor);
                }
                if (text[cursor] !== '}' && text[cursor] !== ']') {
                    writer.write(commas[depth]);
                }
                continue;
            }
            if (char === ':') {
                writer.write(this.indent ? ': ' : ':');
                cursor = start + 1;
                continue;
            }

            const end = char === '"' ? this.scanString(text, start)
                : char === 't' || char === 'n' ? start + 4
                : char === 'f' ? start + 5 : this.scanNumber(text, start);
            if (end <= start) {
                throw new Error('Invalid token end in a validated JSON segment');
            }
            cursor = end;
            if (char === '"' && text[this.skipTrivia(text, end)] !== ':') {
                this.writeStringValue(text, start, end, writer, depth, visitOffset, false);
            } else {
                writer.write(text, start, end);
            }
        }
    }
}
