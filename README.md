# JSON Segment Formatter

Format JSON segments in any file while preserving non-JSON content.

## Features

- **Smart Detection** - Automatically identifies and formats JSON segments (`{}` and `[]`) in any file
- **Preserve Context** - Keeps non-JSON content unchanged (headers, comments, logs, etc.)
- **Relaxed JSON Support** - Handles comments, trailing commas, and other JSON5-style features
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
- Handles unquoted keys
- Converts single quotes to double quotes

## Requirements

- VS Code 1.80.0 or higher

## License

MIT
