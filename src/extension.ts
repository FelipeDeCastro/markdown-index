import * as vscode from 'vscode';
import { HeadingNode } from './headingParser';
import { HeadingTreeProvider, isMarkdownDocument } from './headingProvider';
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

  // --- Active Document Resolution ---

  async function getActiveMarkdownDocument(): Promise<vscode.TextDocument | undefined> {
    // 1. Check active text editor
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && isMarkdownDocument(activeEditor.document)) {
      return activeEditor.document;
    }

    // 2. Check active custom Markdown preview panel
    const activePreview = MarkdownPreviewPanel.getActivePreviewPanel();
    if (activePreview?.getDocument()) {
      return activePreview.getDocument();
    }

    // 3. Check active tab in tabGroups (e.g. built-in preview tab or custom editor tab)
    const activeTab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
    if (activeTab) {
      const input = activeTab.input;
      let uri: vscode.Uri | undefined;
      if (input instanceof vscode.TabInputText) {
        uri = input.uri;
      } else if (input instanceof vscode.TabInputCustom) {
        uri = input.uri;
      }
      if (uri) {
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          if (isMarkdownDocument(doc)) {
            return doc;
          }
        } catch {
          // Ignore
        }
      }
    }

    return undefined;
  }

  let isUpdatingTree = false;

  async function updateTreeForActiveDocument(): Promise<void> {
    if (isUpdatingTree) {
      return;
    }
    isUpdatingTree = true;
    try {
      const doc = await getActiveMarkdownDocument();
      if (doc) {
        provider.refresh(doc);
      } else {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && !isMarkdownDocument(activeEditor.document)) {
          provider.refresh(activeEditor.document);
        } else if (
          !activeEditor &&
          vscode.window.visibleTextEditors.length === 0 &&
          MarkdownPreviewPanel.getAllPanels().length === 0
        ) {
          provider.clear();
        }
      }
    } finally {
      isUpdatingTree = false;
    }
  }

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
    vscode.commands.registerCommand('markdownIndex.openCustomPreview', async (uri?: vscode.Uri) => {
      if (uri && uri.scheme) {
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          await MarkdownPreviewPanel.createOrShow(context.extensionUri, doc);
          await updateTreeForActiveDocument();
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('markdown-index: failed to open preview for uri', uri, err);
        }
      } else {
        await openPreviewForActiveOrVisibleMarkdown();
        await updateTreeForActiveDocument();
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('markdownIndex.openBrowserPreview', async (uri?: vscode.Uri) => {
      let targetUri = uri;
      if (!targetUri || !targetUri.scheme) {
        const activeDoc = await getActiveMarkdownDocument();
        targetUri = activeDoc?.uri;
      }
      if (targetUri) {
        try {
          await MarkdownPreviewPanel.openInBrowser(context.extensionUri, targetUri);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('markdown-index: failed to open browser preview for uri', targetUri, err);
        }
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('markdownIndex.refresh', async () => {
      await updateTreeForActiveDocument();
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

  // --- Editor & Preview tracking ---

  let treeDebounceTimer: ReturnType<typeof setTimeout> | undefined;

  const scheduleTreeRefresh = (document: vscode.TextDocument | undefined) => {
    if (treeDebounceTimer) {
      clearTimeout(treeDebounceTimer);
    }
    treeDebounceTimer = setTimeout(() => {
      provider.refresh(document);
    }, 300);
  };

  // Keyed per-document so editing one file's preview panel never cancels a
  // pending refresh for another file's panel (each panel updates independently).
  const previewDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const schedulePreviewRefresh = (document: vscode.TextDocument) => {
    const key = document.uri.toString();
    const existingTimer = previewDebounceTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    previewDebounceTimers.set(
      key,
      setTimeout(() => {
        previewDebounceTimers.delete(key);
        MarkdownPreviewPanel.updateIfOpen(document);
      }, 300),
    );
  };

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(async () => {
      if (provider.filterTerm) {
        provider.setFilter(undefined);
        await vscode.commands.executeCommand('setContext', 'markdownIndex.isFiltered', false);
      }
      await vscode.commands.executeCommand('setContext', 'markdownIndex.allCollapsed', false);
      await updateTreeForActiveDocument();
    }),
  );

  context.subscriptions.push(
    MarkdownPreviewPanel.onDidChangeActivePreview(async () => {
      if (provider.filterTerm) {
        provider.setFilter(undefined);
        await vscode.commands.executeCommand('setContext', 'markdownIndex.isFiltered', false);
      }
      await vscode.commands.executeCommand('setContext', 'markdownIndex.allCollapsed', false);
      await updateTreeForActiveDocument();
    }),
  );

  if (vscode.window.tabGroups) {
    context.subscriptions.push(
      vscode.window.tabGroups.onDidChangeTabs(() => void updateTreeForActiveDocument()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => void updateTreeForActiveDocument()),
    );
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      // The sidebar/index tree only ever shows one document, so keep its
      // refresh scoped to the active markdown document.
      void getActiveMarkdownDocument().then((activeDoc) => {
        if (activeDoc && event.document.uri.toString() === activeDoc.uri.toString()) {
          scheduleTreeRefresh(activeDoc);
        }
      });
      // Live preview updates apply to whichever document was edited, regardless
      // of which editor is currently active — each open preview panel is
      // independent and should always reflect its own file's latest content.
      schedulePreviewRefresh(event.document);
    }),
  );

  context.subscriptions.push(treeView, sidebarTreeView);

  // Initialize with current active document
  void updateTreeForActiveDocument();

  // Helper to open preview for an active or visible markdown editor.
  async function openPreviewForActiveOrVisibleMarkdown(): Promise<void> {
    try {
      const activeDoc = await getActiveMarkdownDocument();
      if (activeDoc) {
        await MarkdownPreviewPanel.createOrShow(context.extensionUri, activeDoc);
        return;
      }

      const active = vscode.window.activeTextEditor;
      let targetEditor: vscode.TextEditor | undefined = undefined;

      if (isMarkdownDocument(active?.document)) {
        targetEditor = active;
      } else {
        targetEditor = vscode.window.visibleTextEditors.find((e) => isMarkdownDocument(e.document));
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
        void openPreviewForActiveOrVisibleMarkdown().then(() => updateTreeForActiveDocument());
      }
    }),
    sidebarTreeView.onDidChangeVisibility((e) => {
      if (e.visible) {
        void openPreviewForActiveOrVisibleMarkdown().then(() => updateTreeForActiveDocument());
      }
    }),
  );
}

export function deactivate(): void {
  // Nothing to clean up.
}
