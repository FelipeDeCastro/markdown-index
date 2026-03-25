import * as vscode from 'vscode';
import { HeadingNode } from './headingParser';
import { HeadingTreeProvider } from './headingProvider';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new HeadingTreeProvider();

  const treeView = vscode.window.createTreeView('markdownIndex', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });

  // --- Helpers ---

  async function revealInEditor(node: HeadingNode): Promise<void> {
    const uri = provider.documentUri;
    let editor = vscode.window.activeTextEditor;
    if ((!editor || editor.document.uri.toString() !== uri?.toString()) && uri) {
      const doc = await vscode.workspace.openTextDocument(uri);
      editor = await vscode.window.showTextDocument(doc, { preview: false });
    }
    if (!editor) {
      return;
    }
    const range = editor.document.lineAt(node.line).range;
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    editor.selection = new vscode.Selection(range.start, range.start);
  }

  async function revealInPreview(node: HeadingNode): Promise<void> {
    const uri = provider.documentUri;
    if (!uri) {
      return;
    }
    // Ensure the document is open and cursor is at the heading line
    // so the preview scroll-sync can follow.
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, {
      preview: false,
      preserveFocus: false,
    });
    const range = doc.lineAt(node.line).range;
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    editor.selection = new vscode.Selection(range.start, range.start);

    // Open / focus the markdown preview (syncs to cursor position).
    await vscode.commands.executeCommand('markdown.showPreview');
  }

  // --- Commands ---

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'markdownIndex.revealHeading',
      async (node: HeadingNode) => {
        const action = vscode.workspace
          .getConfiguration('markdownIndex')
          .get<string>('clickAction', 'editor');
        if (action === 'preview') {
          await revealInPreview(node);
        } else {
          await revealInEditor(node);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('markdownIndex.revealInEditor', revealInEditor),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('markdownIndex.revealInPreview', revealInPreview),
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
