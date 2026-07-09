import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import MarkdownIt = require('markdown-it');

type PreviewTheme = 'auto' | 'light' | 'dark';
type ResolvedTheme = 'light' | 'dark';

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

/** Resolves the configured theme preference to a concrete light/dark value. */
function resolveTheme(pref: PreviewTheme): ResolvedTheme {
  if (pref === 'light' || pref === 'dark') {
    return pref;
  }
  const kind = vscode.window.activeColorTheme.kind;
  return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight
    ? 'light'
    : 'dark';
}

/**
 * Custom markdown preview panel: GitHub-styled rendering with print support,
 * a light/dark theme toggle, and double-click-to-source navigation.
 */
export class MarkdownPreviewPanel {
  static currentPanel: MarkdownPreviewPanel | undefined;

  private static readonly viewType = 'markdownIndexPreview';
  private static readonly md = new MarkdownIt({ html: true, linkify: true }).use(
    (md: MarkdownIt) => {
      md.core.ruler.push('markdown_index_data_line', (state) => {
        for (const token of state.tokens) {
          if (token.map && (token.nesting === 1 || token.nesting === 0)) {
            token.attrSet('data-line', String(token.map[0]));
          }
        }
      });
    },
  );

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly disposables: vscode.Disposable[] = [];
  private documentUri: vscode.Uri | undefined;

  static async createOrShow(
    extensionUri: vscode.Uri,
    document: vscode.TextDocument,
  ): Promise<void> {
    if (MarkdownPreviewPanel.currentPanel) {
      // Reveal in place — do not move the panel to a different column.
      MarkdownPreviewPanel.currentPanel.panel.reveal(undefined, true);
      await MarkdownPreviewPanel.currentPanel.setDocument(document);
      return;
    }

    // Open in the same column as the document's editor (if visible), so the
    // preview replaces/tabs alongside the editor instead of splitting the layout.
    const visibleEditor = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.toString() === document.uri.toString(),
    );
    const column = visibleEditor?.viewColumn ?? vscode.ViewColumn.Active;

    const panel = vscode.window.createWebviewPanel(
      MarkdownPreviewPanel.viewType,
      `Preview ${path.basename(document.fileName)}`,
      { viewColumn: column, preserveFocus: true },
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources', 'preview')],
      },
    );

    MarkdownPreviewPanel.currentPanel = new MarkdownPreviewPanel(panel, extensionUri);
    await MarkdownPreviewPanel.currentPanel.setDocument(document);
  }

  /** Re-renders the preview if it currently shows the given document. */
  static updateIfActive(document: vscode.TextDocument): void {
    const current = MarkdownPreviewPanel.currentPanel;
    if (current && current.documentUri?.toString() === document.uri.toString()) {
      current.render(document);
    }
  }

  /** Scrolls the preview to the given line, if it currently shows that document. */
  static scrollToLineIfActive(uri: vscode.Uri, line: number): void {
    const current = MarkdownPreviewPanel.currentPanel;
    if (current && current.documentUri?.toString() === uri.toString()) {
      current.scrollToLine(line);
    }
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message) => this.handleMessage(message),
      null,
      this.disposables,
    );
    // When the preference is 'auto', keep the preview in sync with live
    // VS Code theme changes instead of only resolving it at render time.
    vscode.window.onDidChangeActiveColorTheme(
      () => this.handleActiveColorThemeChange(),
      null,
      this.disposables,
    );
  }

  private handleActiveColorThemeChange(): void {
    const pref = vscode.workspace
      .getConfiguration('markdownIndex')
      .get<PreviewTheme>('previewTheme', 'auto');
    if (pref !== 'auto') {
      return;
    }
    void this.panel.webview.postMessage({ type: 'setResolvedTheme', theme: resolveTheme(pref) });
  }

  private async setDocument(document: vscode.TextDocument): Promise<void> {
    this.documentUri = document.uri;
    this.panel.title = `Preview ${path.basename(document.fileName)}`;
    this.renderFull(document);
  }

  private render(document: vscode.TextDocument): void {
    const html = MarkdownPreviewPanel.md.render(document.getText());
    void this.panel.webview.postMessage({ type: 'update', html });
  }

  scrollToLine(line: number): void {
    void this.panel.webview.postMessage({ type: 'scrollToLine', line });
  }

  private async handleMessage(message: { type: string; line?: number; theme?: PreviewTheme }): Promise<void> {
    switch (message.type) {
      case 'reveal':
        if (typeof message.line === 'number') {
          await this.revealLine(message.line);
        }
        break;
      case 'setTheme':
        if (message.theme) {
          await vscode.workspace
            .getConfiguration('markdownIndex')
            .update('previewTheme', message.theme, vscode.ConfigurationTarget.Global);
        }
        break;
      case 'print':
        await this.printCurrentDocument();
        break;
    }
  }

  /**
   * VS Code webviews run in a sandboxed iframe without `allow-modals`, so
   * `window.print()` is silently blocked inside the panel. Instead, render a
   * standalone HTML file (with the same CSS inlined) and open it in the
   * user's default browser, which supports printing natively.
   */
  private async printCurrentDocument(): Promise<void> {
    if (!this.documentUri) {
      return;
    }
    const doc = await vscode.workspace.openTextDocument(this.documentUri);
    const bodyHtml = MarkdownPreviewPanel.md.render(doc.getText());
    const theme = vscode.workspace
      .getConfiguration('markdownIndex')
      .get<PreviewTheme>('previewTheme', 'auto');
    const resolvedTheme = resolveTheme(theme);

    const previewDir = vscode.Uri.joinPath(this.extensionUri, 'resources', 'preview').fsPath;
    const css = [
      fs.readFileSync(path.join(previewDir, 'github-markdown.css'), 'utf8'),
      fs.readFileSync(path.join(previewDir, 'theme-override.css'), 'utf8'),
    ].join('\n');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${path.basename(doc.fileName)}</title>
<style>
${css}
body { margin: 0; background-color: var(--bgColor-default); }
.markdown-body { box-sizing: border-box; max-width: 900px; margin: 0 auto; padding: 24px 32px 64px; }
</style>
</head>
<body>
<article class="markdown-body" data-theme="${resolvedTheme}">${bodyHtml}</article>
<script>window.onload = function () { window.print(); };</script>
</body>
</html>`;

    const tmpFile = path.join(os.tmpdir(), `markdown-index-print-${Date.now()}.html`);
    fs.writeFileSync(tmpFile, html, 'utf8');
    await vscode.env.openExternal(vscode.Uri.file(tmpFile));
  }

  private async revealLine(line: number): Promise<void> {
    if (!this.documentUri) {
      return;
    }
    const doc = await vscode.workspace.openTextDocument(this.documentUri);
    const visible = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.toString() === this.documentUri?.toString(),
    );
    const column = visible?.viewColumn ?? vscode.ViewColumn.Beside;
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: column,
      preserveFocus: false,
      preview: false,
    });
    const clampedLine = Math.min(line, doc.lineCount - 1);
    const range = doc.lineAt(clampedLine).range;
    editor.revealRange(range, vscode.TextEditorRevealType.AtTop);
    editor.selection = new vscode.Selection(range.start, range.start);
  }

  private renderFull(document: vscode.TextDocument): void {
    const html = MarkdownPreviewPanel.md.render(document.getText());
    this.panel.webview.html = this.getHtmlForWebview(html);
  }

  /**
   * Builds a webview URI for a resource under resources/preview, with a
   * cache-busting query string derived from the file's mtime. Without this,
   * the webview's underlying Chromium session can keep serving a previously
   * fetched version of a stylesheet by URI even after its on-disk content
   * changes (e.g. across extension reloads that reuse the same panel).
   */
  private resourceUri(webview: vscode.Webview, ...pathSegments: string[]): vscode.Uri {
    const fsPath = vscode.Uri.joinPath(this.extensionUri, 'resources', 'preview', ...pathSegments);
    let version = '0';
    try {
      version = String(fs.statSync(fsPath.fsPath).mtimeMs);
    } catch {
      // Fall back to no cache-busting if the file can't be stat'd.
    }
    return webview.asWebviewUri(fsPath).with({ query: `v=${version}` });
  }

  private getHtmlForWebview(bodyHtml: string): string {
    const webview = this.panel.webview;
    const cssUri = this.resourceUri(webview, 'github-markdown.css');
    const nonce = getNonce();
    const theme = vscode.workspace
      .getConfiguration('markdownIndex')
      .get<PreviewTheme>('previewTheme', 'auto');
    const resolvedTheme = resolveTheme(theme);
    const themeOverrideCssUri = this.resourceUri(webview, 'theme-override.css');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${cssUri}">
<link rel="stylesheet" href="${themeOverrideCssUri}">
<style>
  html, body { height: 100%; }
  body {
    margin: 0;
    padding: 0;
    background-color: var(--vscode-editor-background);
  }
  .mi-toolbar {
    position: sticky;
    top: 0;
    display: flex;
    justify-content: flex-end;
    gap: 4px;
    padding: 6px 12px;
    background-color: var(--vscode-editor-background);
    border-bottom: 1px solid var(--vscode-widget-border, transparent);
    z-index: 10;
  }
  .mi-toolbar button {
    background: transparent;
    border: 1px solid var(--vscode-button-border, transparent);
    color: var(--vscode-foreground);
    border-radius: 4px;
    padding: 4px 8px;
    cursor: pointer;
    font-size: 13px;
  }
  .mi-toolbar button:hover {
    background-color: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2));
  }
  .mi-toolbar button.mi-icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 4px;
  }
  .mi-icon-btn svg {
    display: block;
  }
  .markdown-body {
    box-sizing: border-box;
    padding: 24px 32px 64px;
  }
  @media print {
    .mi-toolbar { display: none; }
    .markdown-body { max-width: none; padding: 0; }
  }
</style>
</head>
<body>
  <div class="mi-toolbar">
    <button id="mi-theme-toggle" class="mi-icon-btn" title="Toggle light/dark theme">
      <svg id="mi-icon-sun" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="4"></circle>
        <line x1="12" y1="2" x2="12" y2="4"></line>
        <line x1="12" y1="20" x2="12" y2="22"></line>
        <line x1="4.93" y1="4.93" x2="6.34" y2="6.34"></line>
        <line x1="17.66" y1="17.66" x2="19.07" y2="19.07"></line>
        <line x1="2" y1="12" x2="4" y2="12"></line>
        <line x1="20" y1="12" x2="22" y2="12"></line>
        <line x1="4.93" y1="19.07" x2="6.34" y2="17.66"></line>
        <line x1="17.66" y1="6.34" x2="19.07" y2="4.93"></line>
      </svg>
      <svg id="mi-icon-moon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
      </svg>
    </button>
    <button id="mi-print" title="Print">Print</button>
  </div>
  <article class="markdown-body" id="mi-content" data-theme="${resolvedTheme}">${bodyHtml}</article>
  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      const content = document.getElementById('mi-content');
      const sunIcon = document.getElementById('mi-icon-sun');
      const moonIcon = document.getElementById('mi-icon-moon');

      function updateThemeIcon(theme) {
        sunIcon.style.display = theme === 'dark' ? 'none' : 'block';
        moonIcon.style.display = theme === 'dark' ? 'block' : 'none';
      }
      updateThemeIcon(content.getAttribute('data-theme'));

      document.getElementById('mi-theme-toggle').addEventListener('click', () => {
        const next = content.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        content.setAttribute('data-theme', next);
        updateThemeIcon(next);
        vscode.postMessage({ type: 'setTheme', theme: next });
      });

      document.getElementById('mi-print').addEventListener('click', () => {
        vscode.postMessage({ type: 'print' });
      });

      content.addEventListener('dblclick', (event) => {
        const target = event.target.closest('[data-line]');
        if (target) {
          const line = parseInt(target.getAttribute('data-line'), 10);
          if (!isNaN(line)) {
            vscode.postMessage({ type: 'reveal', line });
          }
        }
      });

      window.addEventListener('message', (event) => {
        const message = event.data;
        if (message.type === 'update') {
          content.innerHTML = message.html;
        } else if (message.type === 'scrollToLine') {
          const nodes = content.querySelectorAll('[data-line]');
          let best = null;
          for (const node of nodes) {
            const nodeLine = parseInt(node.getAttribute('data-line'), 10);
            if (nodeLine <= message.line) {
              best = node;
            } else {
              break;
            }
          }
          if (best) {
            best.scrollIntoView({ block: 'start' });
          }
        } else if (message.type === 'setResolvedTheme') {
          content.setAttribute('data-theme', message.theme);
          updateThemeIcon(message.theme);
        }
      });
    }());
  </script>
</body>
</html>`;
  }

  private dispose(): void {
    MarkdownPreviewPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      d?.dispose();
    }
  }
}
