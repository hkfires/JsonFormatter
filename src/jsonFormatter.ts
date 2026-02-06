/**
 * JSON 段落格式化器
 * - 识别并格式化文件中的 JSON 段落
 * - 保留非 JSON 内容不变
 * - 支持宽松的 JSON 解析（注释、尾随逗号等）
 */

interface JsonSegment {
    start: number;  // 段落起始位置
    end: number;    // 段落结束位置
    parsed: unknown; // 解析后的 JSON 值
}

export class JsonFormatter {

    private readonly indent: string;

    constructor(indentSize: number = 2, useSpaces: boolean = true) {
        this.indent = useSpaces ? ' '.repeat(indentSize) : '\t';
    }

    /**
     * 格式化文本中的 JSON 段落
     */
    public format(text: string): string {
        // 查找所有 JSON 段落
        const segments = this.findJsonSegments(text);

        if (segments.length === 0) {
            return text;  // 没有找到 JSON，保持原样
        }

        // 按顺序拼接，避免多次大字符串重建
        const chunks: string[] = [];
        let cursor = 0;

        for (const segment of segments) {
            chunks.push(text.slice(cursor, segment.start));
            chunks.push(this.formatParsedJson(segment.parsed));
            cursor = segment.end;
        }
        chunks.push(text.slice(cursor));

        return chunks.join('');
    }

    /**
     * 查找文本中的所有 JSON 段落
     */
    private findJsonSegments(text: string): JsonSegment[] {
        const segments: JsonSegment[] = [];
        let i = 0;

        while (i < text.length) {
            // 跳过空白
            while (i < text.length && /\s/.test(text[i])) {
                i++;
            }

            if (i >= text.length) break;

            // 查找 JSON 对象或数组的开始
            if (text[i] === '{' || text[i] === '[') {
                const start = i;
                const end = this.findJsonEnd(text, i);

                if (end > start) {
                    const jsonText = text.substring(start, end);
                    const parsed = this.parseJsonValue(jsonText);

                    // 验证是否是有效的 JSON
                    if (parsed !== null) {
                        segments.push({ start, end, parsed });
                        i = end;
                    } else {
                        // 如果当前大段不是 JSON，继续向后扫描，避免漏掉内部/后续 JSON 段
                        i = start + 1;
                    }
                } else {
                    i++;
                }
            } else {
                i++;
            }
        }

        return segments;
    }

    /**
     * 查找 JSON 对象/数组的结束位置
     */
    private findJsonEnd(text: string, start: number): number {
        const startChar = text[start];
        const endChar = startChar === '{' ? '}' : ']';
        let depth = 0;
        let inString = false;
        let escapeNext = false;

        for (let i = start; i < text.length; i++) {
            const char = text[i];

            if (escapeNext) {
                escapeNext = false;
                continue;
            }

            if (char === '\\' && inString) {
                escapeNext = true;
                continue;
            }

            // JSON 字符串只使用双引号；单引号可能只是普通字符（如 file's）
            if (char === '"') {
                inString = !inString;
                continue;
            }

            if (inString) {
                continue;
            }

            if (char === startChar) {
                depth++;
            } else if (char === endChar) {
                depth--;
                if (depth === 0) {
                    return i + 1;  // 包含结束字符
                }
            }
        }

        return -1;  // 没有找到匹配的结束符
    }

    /**
     * 格式化 JSON 文本
     */
    private formatParsedJson(parsed: unknown): string {
        const expanded = this.expandNestedJsonStrings(parsed);
        return JSON.stringify(expanded, null, this.indent);
    }

    /**
     * 解析 JSON（标准或宽松）
     */
    private parseJsonValue(text: string): unknown | null {
        const trimmed = text.trim();
        if (!trimmed) {
            return null;
        }

        try {
            return JSON.parse(trimmed);
        } catch {
            if (!this.shouldTryRelaxedParse(trimmed)) {
                return null;
            }

            const relaxed = this.tryRelaxedParse(trimmed);
            if (relaxed !== null) {
                try {
                    return JSON.parse(relaxed);
                } catch {
                    return null;
                }
            }
            return null;
        }
    }

    /**
     * 递归展开字符串中的 JSON（例如 arguments: "{\"a\":1}"）
     */
    private expandNestedJsonStrings(value: unknown, depth: number = 0): unknown {
        // 避免极端深度导致递归风险
        if (depth > 30) {
            return value;
        }

        if (Array.isArray(value)) {
            for (let index = 0; index < value.length; index++) {
                value[index] = this.expandNestedJsonStrings(value[index], depth + 1);
            }
            return value;
        }

        if (value !== null && typeof value === 'object') {
            const objectValue = value as Record<string, unknown>;
            for (const key of Object.keys(objectValue)) {
                objectValue[key] = this.expandNestedJsonStrings(objectValue[key], depth + 1);
            }
            return objectValue;
        }

        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (this.looksLikeJsonContainer(trimmed) && this.mightContainJsonStructure(trimmed)) {
                const nested = this.parseJsonValue(trimmed);
                if (nested !== null) {
                    return this.expandNestedJsonStrings(nested, depth + 1);
                }
            }
        }

        return value;
    }

    /**
     * 快速判断字符串是否可能是 JSON 对象/数组
     */
    private looksLikeJsonContainer(text: string): boolean {
        if (text.length < 2) {
            return false;
        }

        const first = text[0];
        const last = text[text.length - 1];
        return (first === '{' && last === '}') || (first === '[' && last === ']');
    }

    /**
     * 快速判断字符串内容是否像 JSON 结构，减少无效 JSON.parse 调用
     */
    private mightContainJsonStructure(text: string): boolean {
        if (text[0] === '{') {
            return text === '{}' || text.includes(':');
        }

        // 数组可能是对象数组，也可能是字符串/数字/布尔/null 数组
        return text === '[]'
            || text.includes(',')
            || text.includes('{')
            || text.includes('[')
            || text.includes('"')
            || /[\d\-tfn]/.test(text);
    }

    /**
     * 仅在可能被宽松规则修复时尝试宽松解析
     */
    private shouldTryRelaxedParse(text: string): boolean {
        return text.includes('//')
            || text.includes('/*')
            || text.includes(',}')
            || text.includes(',]')
            || text.includes(', }')
            || text.includes(', ]');
    }

    /**
     * 尝试宽松解析（支持注释、尾随逗号等）
     */
    private tryRelaxedParse(text: string): string | null {
        try {
            let cleaned = text;

            // 移除单行注释（但要小心字符串中的 //）
            cleaned = this.removeLineComments(cleaned);

            // 移除多行注释
            cleaned = this.removeBlockComments(cleaned);

            // 移除尾随逗号
            cleaned = cleaned.replace(/,(\s*[}\]])/g, '$1');

            // 验证
            JSON.parse(cleaned);
            return cleaned;
        } catch {
            return null;
        }
    }

    /**
     * 移除单行注释（保留字符串中的 //）
     */
    private removeLineComments(text: string): string {
        let result = '';
        let inString = false;
        let escapeNext = false;
        let i = 0;

        while (i < text.length) {
            const char = text[i];

            if (escapeNext) {
                result += char;
                escapeNext = false;
                i++;
                continue;
            }

            if (char === '\\' && inString) {
                result += char;
                escapeNext = true;
                i++;
                continue;
            }

            if (char === '"') {
                inString = !inString;
                result += char;
                i++;
                continue;
            }

            if (!inString && char === '/' && i + 1 < text.length && text[i + 1] === '/') {
                // 找到注释开始，跳到行尾
                while (i < text.length && text[i] !== '\n' && text[i] !== '\r') {
                    i++;
                }
                // 保留换行符
                if (i < text.length && (text[i] === '\n' || text[i] === '\r')) {
                    result += text[i];
                    i++;
                    if (i < text.length && text[i] === '\n' && text[i - 1] === '\r') {
                        result += text[i];
                        i++;
                    }
                }
                continue;
            }

            result += char;
            i++;
        }

        return result;
    }

    /**
     * 移除多行注释（保留字符串中的 /* * /）
     */
    private removeBlockComments(text: string): string {
        let result = '';
        let inString = false;
        let escapeNext = false;
        let inBlockComment = false;
        let i = 0;

        while (i < text.length) {
            const char = text[i];

            if (inBlockComment) {
                if (char === '*' && i + 1 < text.length && text[i + 1] === '/') {
                    inBlockComment = false;
                    i += 2;
                } else {
                    i++;
                }
                continue;
            }

            if (escapeNext) {
                result += char;
                escapeNext = false;
                i++;
                continue;
            }

            if (char === '\\' && inString) {
                result += char;
                escapeNext = true;
                i++;
                continue;
            }

            if (char === '"') {
                inString = !inString;
                result += char;
                i++;
                continue;
            }

            if (!inString && char === '/' && i + 1 < text.length && text[i + 1] === '*') {
                inBlockComment = true;
                i += 2;
                continue;
            }

            result += char;
            i++;
        }

        return result;
    }
}
