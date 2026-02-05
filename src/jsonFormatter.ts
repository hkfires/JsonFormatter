/**
 * JSON 段落格式化器
 * - 识别并格式化文件中的 JSON 段落
 * - 保留非 JSON 内容不变
 * - 支持宽松的 JSON 解析（注释、尾随逗号等）
 */

interface JsonSegment {
    start: number;  // 段落起始位置
    end: number;    // 段落结束位置
    json: string;   // 原始 JSON 文本
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

        // 从后往前替换，避免位置偏移
        let result = text;
        for (let i = segments.length - 1; i >= 0; i--) {
            const segment = segments[i];
            const formatted = this.formatJson(segment.json);
            result = result.substring(0, segment.start) + formatted + result.substring(segment.end);
        }

        return result;
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

                    // 验证是否是有效的 JSON
                    if (this.looksLikeJson(jsonText)) {
                        segments.push({ start, end, json: jsonText });
                    }
                    i = end;
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

            if (char === '"' || char === "'") {
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
     * 检查文本是否看起来像 JSON
     */
    private looksLikeJson(text: string): boolean {
        const trimmed = text.trim();

        // 尝试标准 JSON
        if (this.tryParse(trimmed)) {
            return true;
        }

        // 尝试宽松解析
        const relaxed = this.tryRelaxedParse(trimmed);
        return relaxed !== null;
    }

    /**
     * 尝试解析标准 JSON
     */
    private tryParse(text: string): boolean {
        try {
            JSON.parse(text);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * 格式化 JSON 文本
     */
    private formatJson(text: string): string {
        // 尝试标准格式化
        if (this.tryParse(text)) {
            return JSON.stringify(JSON.parse(text), null, this.indent);
        }

        // 尝试宽松格式化
        const relaxed = this.tryRelaxedParse(text);
        if (relaxed !== null) {
            return JSON.stringify(JSON.parse(relaxed), null, this.indent);
        }

        // 无法解析，返回原样
        return text;
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
