import * as vscode from 'vscode';
import { JsonFormatter } from './jsonFormatter';

export function activate(context: vscode.ExtensionContext) {
    console.log('JSON 强制格式化插件已激活');

    const formatter = new JsonFormatter();

    // 注册格式化命令
    const formatCommand = vscode.commands.registerCommand(
        'jsonSegmentFormatter.format',
        async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('没有打开的文件');
                return;
            }

            const document = editor.document;
            const text = document.getText();

            try {
                // Match VS Code's line-ending normalization before checking for changes.
                const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
                const formatted = formatter.format(text).replace(/\r\n|\r|\n/g, eol);
                if (formatted === text) {
                    vscode.window.showInformationMessage('内容无需更改');
                    return;
                }

                // Replace the entire document only when the content has changed.
                const fullRange = new vscode.Range(
                    document.positionAt(0),
                    document.positionAt(text.length)
                );

                const applied = await editor.edit(editBuilder => {
                    editBuilder.replace(fullRange, formatted);
                });
                if (!applied) {
                    vscode.window.showErrorMessage('格式化失败: 编辑器未应用更改');
                    return;
                }

                vscode.window.showInformationMessage('JSON 格式化完成');
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`格式化失败: ${errorMessage}`);
            }
        }
    );

    context.subscriptions.push(formatCommand);
}

export function deactivate() {
    console.log('JSON 强制格式化插件已停用');
}
