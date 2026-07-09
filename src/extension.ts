import * as vscode from 'vscode';
import { HeadingNode } from './headingParser';
import { HeadingTreeProvider } from './headingProvider';
import { MarkdownPreviewPanel } from './previewPanel';

export function activate(context: vscode.ExtensionContext): void {
  console.log('Markdown Index extension is now active.');
  const provider = new HeadingTreeProvider();

  const treeView = vscode.window.createTreeView('markdownIndex', {
    treeDataProvider: provider,
  });

  const sidebarTreeView = vscode.window.createTreeView('markdownIndexSidebarView', {
    treeDataProvider: provider,
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
    editor.revealRange(range, vscode.TextEditorRevealType.AtTop);
    editor.selection = new vscode.Selection(range.start, range.start);
  }

  async function revealInPreview(node: HeadingNode): Promise<void> {
    const uri = provider.documentUri;
    if (!uri) {
      return;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    await MarkdownPreviewPanel.createOrShow(context.extensionUri, doc);
    MarkdownPreviewPanel.scrollToLineIfActive(doc.uri, node.line);
  }

  // --- Commands ---

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'markdownIndex.revealHeading',
      async (node: HeadingNode) => {
        const action = vscode.workspace
          .getConfiguration('markdownIndex')
          .get<string>('clickAction', 'preview');
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
    vscode.commands.registerCommand('markdownIndex.openCustomPreview', async () => {
      await openPreviewForActiveOrVisibleMarkdown();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('markdownIndex.refresh', () => {
      provider.refresh(vscode.window.activeTextEditor?.document);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('markdownIndex.collapseAll', async () => {
      provider.collapseAll();
      await vscode.commands.executeCommand('setContext', 'markdownIndex.allCollapsed', true);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('markdownIndex.expandAll', async () => {
      provider.expandAll();
      await vscode.commands.executeCommand('setContext', 'markdownIndex.allCollapsed', false);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('markdownIndex.search', async () => {
      const term = await vscode.window.showInputBox({
        prompt: 'Filter headings by term',
        value: provider.filterTerm ?? '',
      });
      if (term === undefined) {
        return; // cancelled
      }
      if (term === '') {
        provider.setFilter(undefined);
        await vscode.commands.executeCommand('setContext', 'markdownIndex.isFiltered', false);
      } else {
        provider.setFilter(term);
        await vscode.commands.executeCommand('setContext', 'markdownIndex.isFiltered', true);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('markdownIndex.clearSearch', async () => {
      provider.setFilter(undefined);
      await vscode.commands.executeCommand('setContext', 'markdownIndex.isFiltered', false);
    }),
  );

  // --- Editor tracking ---

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  const scheduleRefresh = (document: vscode.TextDocument | undefined) => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      provider.refresh(document);
      if (document) {
        MarkdownPreviewPanel.updateIfActive(document);
      }
    }, 300);
  };

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(async (editor) => {
      if (provider.filterTerm) {
        provider.setFilter(undefined);
        await vscode.commands.executeCommand('setContext', 'markdownIndex.isFiltered', false);
      }
      await vscode.commands.executeCommand('setContext', 'markdownIndex.allCollapsed', false);
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

  context.subscriptions.push(treeView, sidebarTreeView);

  // Initialize with current editor
  provider.refresh(vscode.window.activeTextEditor?.document);

  // Helper to open preview for an active or visible markdown editor.
  async function openPreviewForActiveOrVisibleMarkdown(): Promise<void> {
    try {
      const isMarkdownEditor = (editor?: vscode.TextEditor) =>
        !!editor &&
        (editor.document.languageId === 'markdown' ||
          editor.document.uri.path.toLowerCase().endsWith('.md'));

      const active = vscode.window.activeTextEditor;
      let targetEditor: vscode.TextEditor | undefined = undefined;

      if (isMarkdownEditor(active)) {
        targetEditor = active;
      } else {
        targetEditor = vscode.window.visibleTextEditors.find(isMarkdownEditor);
      }

      if (!targetEditor) {
        return;
      }

      await MarkdownPreviewPanel.createOrShow(context.extensionUri, targetEditor.document);
    } catch (err) {
      // Fail silently — preview is a convenience feature.
      // eslint-disable-next-line no-console
      console.error('markdown-index: failed to open preview', err);
    }
  }

  // Auto-open once on activation
  void openPreviewForActiveOrVisibleMarkdown();

  // Also open every time the view becomes visible (user clicks the extension view).
  context.subscriptions.push(
    treeView.onDidChangeVisibility((e) => {
      if (e.visible) {
        void openPreviewForActiveOrVisibleMarkdown();
      }
    }),
    sidebarTreeView.onDidChangeVisibility((e) => {
      if (e.visible) {
        void openPreviewForActiveOrVisibleMarkdown();
      }
    }),
  );
}

export function deactivate(): void {
  // Nothing to clean up.
}
