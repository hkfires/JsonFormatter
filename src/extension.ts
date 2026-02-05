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
                const formatted = formatter.format(text);

                // 替换整个文档内容
                const fullRange = new vscode.Range(
                    document.positionAt(0),
                    document.positionAt(text.length)
                );

                await editor.edit(editBuilder => {
                    editBuilder.replace(fullRange, formatted);
                });

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
