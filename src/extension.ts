import * as vscode from 'vscode';
import { HeadingNode } from './headingParser';
import { HeadingTreeProvider } from './headingProvider';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new HeadingTreeProvider();

  const treeView = vscode.window.createTreeView('markdownIndex', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });

  // --- Commands ---

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'markdownIndex.revealHeading',
      (node: HeadingNode) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          return;
        }
        const range = editor.document.lineAt(node.line).range;
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        editor.selection = new vscode.Selection(range.start, range.start);
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('markdownIndex.refresh', () => {
      provider.refresh(vscode.window.activeTextEditor?.document);
    }),
  );

  // --- Editor tracking ---

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  const scheduleRefresh = (document: vscode.TextDocument | undefined) => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => provider.refresh(document), 300);
  };

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      provider.refresh(editor?.document);
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      const activeDoc = vscode.window.activeTextEditor?.document;
      if (activeDoc && event.document === activeDoc) {
        scheduleRefresh(activeDoc);
      }
    }),
  );

  context.subscriptions.push(treeView);

  // Initialize with current editor
  provider.refresh(vscode.window.activeTextEditor?.document);
}

export function deactivate(): void {
  // Nothing to clean up.
}
