# JSON Segment Formatter

Format JSON segments in any file while preserving non-JSON content.

## Features

- **Smart Detection** - Automatically identifies and formats JSON segments (`{}` and `[]`) in any file
- **Preserve Context** - Keeps non-JSON content unchanged (headers, comments, logs, etc.)
- **Relaxed JSON Support** - Handles comments and trailing commas
- **Lossless Literals** - Preserves number literals, duplicate keys, key order, and string escapes
- **Nested JSON Expansion** - Expands string values containing JSON objects or arrays into containers
- **File Extension Agnostic** - Works with `.log`, `.txt`, or any file format
- **Keyboard Shortcut** - Default `Ctrl+Alt+J` (Mac: `Cmd+Alt+J`)

## Use Case

Perfect for formatting log files that contain mixed content:

```
=== REQUEST INFO ===
Version: v6.7.46
URL: /v1/chat/completions

=== REQUEST BODY ===
{"model":"gpt-4","messages":[...]}  ← This gets formatted

=== HEADERS ===
Content-Type: application/json       ← This stays unchanged
```

## Usage

1. Open any file containing JSON segments
2. Press `Ctrl+Alt+J` or run `JSON Segment Formatter: Format JSON segments` from Command Palette
3. All JSON segments are formatted, non-JSON content remains untouched

## Supported Auto-fixes

- Removes `//` single-line and `/* */` multi-line comments
- Removes trailing commas

Unquoted keys and single-quoted strings are not supported. Nested JSON expansion intentionally changes string values into objects or arrays.

Indented output is limited to 1,000 indentation levels to prevent excessive output growth. Exceeding this limit reports a formatting error without changing the document. Programmatic compact formatting (`new JsonFormatter(0)`) still supports deeper nesting.

## Development

Use Node.js 22 or newer for development commands:

```sh
npm ci
npm test
npm run benchmark
```

The benchmark compares the working tree against `HEAD` in alternating, isolated Node processes. It checks output hashes and reports median wall time, CPU time, and peak RSS across five rounds, with default and 256 MiB heaps. It exits unsuccessfully if any scenario is not faster than `HEAD`. Set `BENCH_ROUNDS` to increase the sample count; run on an otherwise idle machine.

## Requirements

- VS Code 1.80.0 or higher

## License

MIT
