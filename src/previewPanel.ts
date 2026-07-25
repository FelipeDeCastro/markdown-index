import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import MarkdownIt = require('markdown-it');
import hljs from 'highlight.js/lib/common';
import taskLists = require('markdown-it-task-lists');
import anchor from 'markdown-it-anchor';
import footnote = require('markdown-it-footnote');
import MarkdownItEmoji = require('markdown-it-emoji');
import githubAlerts from 'markdown-it-github-alerts';

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
  /** One panel per document, keyed by `uri.toString()`, so each file gets its own preview window. */
  private static readonly panels = new Map<string, MarkdownPreviewPanel>();

  private static readonly viewType = 'markdownIndexPreview';
  private static readonly md = new MarkdownIt({
    html: true,
    linkify: true,
    // Mermaid fences are intercepted by the fence-rule override below before
    // this callback ever runs for them, so it's safe to always highlight here.
    highlight(code: string, lang: string): string {
      const language = hljs.getLanguage(lang) ? lang : undefined;
      const result = language
        ? hljs.highlight(code, { language })
        : hljs.highlightAuto(code);
      return result.value;
    },
  })
    // No options: markdown-it-task-lists defaults to disabled (read-only)
    // checkboxes, matching how GitHub renders task lists in a plain file
    // view (interactive checkboxes are an issue/PR-only feature).
    .use(taskLists)
    // ariaHidden() only wraps the small "#" permalink symbol in the anchor
    // tag (matching GitHub's own behavior); headerLink() wraps the entire
    // heading text instead, which made headings invisible under our
    // hover-to-reveal .header-anchor CSS (opacity: 0 by default).
    .use(anchor, { permalink: anchor.permalink.ariaHidden() })
    .use(footnote)
    .use(MarkdownItEmoji.full)
    .use(githubAlerts)
    .use((md: MarkdownIt) => {
      md.core.ruler.push('markdown_index_data_line', (state) => {
        for (const token of state.tokens) {
          if (token.map && (token.nesting === 1 || token.nesting === 0)) {
            token.attrSet('data-line', String(token.map[0]));
          }
        }
      });

      // Render ```mermaid fences as a plain container for the mermaid.js
      // client-side renderer (see getHtmlForWebview/printCurrentDocument)
      // instead of running them through the syntax-highlighted <pre><code>
      // default fence renderer.
      const defaultFenceRenderer =
        md.renderer.rules.fence ??
        ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
      md.renderer.rules.fence = (tokens, idx, options, env, self) => {
        const token = tokens[idx];
        const language = token.info.trim().split(/\s+/g)[0];
        if (language === 'mermaid') {
          const line = token.map ? String(token.map[0]) : '0';
          const escaped = md.utils.escapeHtml(token.content);
          return `<pre class="mermaid" data-line="${line}">${escaped}</pre>`;
        }
        return defaultFenceRenderer(tokens, idx, options, env, self);
      };
    });

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly disposables: vscode.Disposable[] = [];
  private documentUri: vscode.Uri | undefined;

  static async createOrShow(
    extensionUri: vscode.Uri,
    document: vscode.TextDocument,
  ): Promise<void> {
    const key = document.uri.toString();
    const existing = MarkdownPreviewPanel.panels.get(key);
    if (existing) {
      // Focus the existing panel for this file in place — do not move it to a
      // different column, and do not repurpose it for a different document.
      existing.panel.reveal(undefined, false);
      return;
    }

    // Open in the same column as the document's editor (if visible), so the
    // preview replaces/tabs alongside the editor instead of splitting the layout.
    const visibleEditor = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.toString() === key,
    );
    const column = visibleEditor?.viewColumn ?? vscode.ViewColumn.Active;

    const panel = vscode.window.createWebviewPanel(
      MarkdownPreviewPanel.viewType,
      `Preview ${path.basename(document.fileName)}`,
      { viewColumn: column, preserveFocus: true },
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources', 'preview')],
        // Without this, VS Code tears down the webview's iframe/JS context
        // whenever it's not the visible tab (not just unfocused) to save
        // memory. That means postMessage-based live updates (see render())
        // sent while a background panel is hidden are silently dropped, so
        // an edited-but-not-visible preview never reflects the latest
        // content until the panel becomes visible again and gets a fresh
        // full HTML render. Keeping the context alive fixes that at the
        // cost of extra memory per open preview panel.
        retainContextWhenHidden: true,
      },
    );

    const instance = new MarkdownPreviewPanel(panel, extensionUri);
    MarkdownPreviewPanel.panels.set(key, instance);
    await instance.setDocument(document);
  }

  /** Re-renders the preview for the given document, if a panel for it is open. */
  static updateIfOpen(document: vscode.TextDocument): void {
    const current = MarkdownPreviewPanel.panels.get(document.uri.toString());
    if (current) {
      current.render(document);
    }
  }

  /** Scrolls the preview to the given line, if a panel for that document is open. */
  static scrollToLineIfActive(uri: vscode.Uri, line: number): void {
    const current = MarkdownPreviewPanel.panels.get(uri.toString());
    if (current) {
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

  private async handleMessage(message: { type: string; line?: number; theme?: PreviewTheme; href?: string }): Promise<void> {
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
      case 'openInBrowser':
        await this.openInBrowser();
        break;
      case 'openExternal':
        if (message.href) {
          await vscode.env.openExternal(vscode.Uri.parse(message.href));
        }
        break;
      case 'openLink':
        if (message.href) {
          await this.openLink(message.href);
        }
        break;
    }
  }

  private async openLink(href: string): Promise<void> {
    if (!this.documentUri) {
      return;
    }

    const [pathPart] = href.split('#');

    let targetUri: vscode.Uri;
    if (pathPart) {
      const decodedPath = decodeURIComponent(pathPart);
      const baseDir = vscode.Uri.joinPath(this.documentUri, '..');
      targetUri = vscode.Uri.joinPath(baseDir, decodedPath);
    } else {
      targetUri = this.documentUri;
    }

    try {
      await vscode.workspace.fs.stat(targetUri);
    } catch {
      void vscode.window.showWarningMessage(`File not found: ${path.basename(targetUri.fsPath)}`);
      return;
    }

    const isMarkdown = /\.(md|markdown|mdown|mkd)$/i.test(targetUri.fsPath);

    if (isMarkdown) {
      const doc = await vscode.workspace.openTextDocument(targetUri);
      await MarkdownPreviewPanel.createOrShow(this.extensionUri, doc);
    } else {
      await vscode.commands.executeCommand('vscode.open', targetUri);
    }
  }

  /**
   * VS Code webviews run in a sandboxed iframe without `allow-modals`, so
   * `window.print()` is silently blocked inside the panel. Instead, render a
   * standalone HTML file (with the same CSS inlined) and open it in the
   * user's default browser, which supports printing natively.
   */
  private async createExternalHtml(autoPrint: boolean = false): Promise<string> {
    if (!this.documentUri) {
      return '';
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
      fs.readFileSync(path.join(previewDir, 'hljs-theme.css'), 'utf8'),
    ].join('\n');
    const mermaidJs = fs.readFileSync(path.join(previewDir, 'mermaid.min.js'), 'utf8');
    const mermaidTheme = resolvedTheme === 'dark' ? 'dark' : 'default';

    return `<!DOCTYPE html>
<html lang="en" data-theme="${resolvedTheme}">
<head>
<meta charset="UTF-8">
<title>${path.basename(doc.fileName)}</title>
<style>
${css}
html, body {
  margin: 0;
  padding: 0;
  min-height: 100vh;
  background-color: var(--bgColor-default, #ffffff);
  color: var(--fgColor-default, #1f2328);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
body {
  display: flex;
  flex-direction: row;
}
.ext-sidebar {
  position: sticky;
  top: 0;
  height: 100vh;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 16px 10px;
  background-color: var(--bgColor-muted, #f6f8fa);
  border-right: 1px solid var(--borderColor-default, #d1d9e0);
  z-index: 1000;
}
.ext-sidebar button {
  background: transparent;
  border: 1px solid var(--borderColor-default, rgba(128,128,128,0.3));
  color: var(--fgColor-default, #24292f);
  border-radius: 6px;
  width: 36px;
  height: 36px;
  padding: 0;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color 0.15s ease, border-color 0.15s ease;
}
.ext-sidebar button:hover {
  background-color: var(--bgColor-neutral-muted, rgba(128,128,128,0.15));
}
.ext-sidebar button svg {
  display: block;
  flex-shrink: 0;
}
.ext-container {
  flex: 1;
  min-width: 0;
}
.markdown-body {
  box-sizing: border-box;
  max-width: 900px;
  margin: 0 auto;
  padding: 32px 40px 64px;
}
@media print {
  body { display: block; }
  .ext-sidebar { display: none !important; }
  .markdown-body { max-width: none; padding: 0; }
}
</style>
</head>
<body>
  <aside class="ext-sidebar">
    <button id="ext-theme-toggle" class="ext-icon-btn" title="Toggle light/dark theme">
      <svg id="ext-icon-sun" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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
      <svg id="ext-icon-moon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
      </svg>
    </button>
    <button id="ext-print" class="ext-icon-btn" title="Print / Save PDF">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="6 9 6 2 18 2 18 9"></polyline>
        <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path>
        <rect x="6" y="14" width="12" height="8"></rect>
      </svg>
    </button>
  </aside>
  <main class="ext-container">
    <article class="markdown-body" id="ext-content" data-theme="${resolvedTheme}">${bodyHtml}</article>
  </main>
<script>${mermaidJs}</script>
<script>
  (async function () {
    const htmlEl = document.documentElement;
    const content = document.getElementById('ext-content');
    const sunIcon = document.getElementById('ext-icon-sun');
    const moonIcon = document.getElementById('ext-icon-moon');
    const rawHtml = content.innerHTML;

    function mermaidThemeFor(theme) {
      return theme === 'dark' ? 'dark' : 'default';
    }

    async function renderMermaid(theme) {
      mermaid.initialize({ startOnLoad: false, theme: mermaidThemeFor(theme) });
      await mermaid.run({ querySelector: '#ext-content pre.mermaid' });
    }

    function updateTheme(theme) {
      htmlEl.setAttribute('data-theme', theme);
      content.setAttribute('data-theme', theme);
      sunIcon.style.display = theme === 'dark' ? 'none' : 'block';
      moonIcon.style.display = theme === 'dark' ? 'block' : 'none';
    }

    updateTheme(content.getAttribute('data-theme'));
    await renderMermaid(content.getAttribute('data-theme'));

    document.getElementById('ext-theme-toggle').addEventListener('click', async () => {
      const next = content.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      content.innerHTML = rawHtml;
      updateTheme(next);
      await renderMermaid(next);
    });

    document.getElementById('ext-print').addEventListener('click', () => {
      window.print();
    });

    if (${autoPrint}) {
      setTimeout(() => {
        window.print();
      }, 250);
    }
  }());
</script>
</body>
</html>`;
  }

  private async printCurrentDocument(): Promise<void> {
    if (!this.documentUri) {
      return;
    }
    const html = await this.createExternalHtml(true);
    const tmpFile = path.join(os.tmpdir(), `markdown-index-print-${Date.now()}.html`);
    fs.writeFileSync(tmpFile, html, 'utf8');
    await vscode.env.openExternal(vscode.Uri.file(tmpFile));
  }

  private async openInBrowser(): Promise<void> {
    if (!this.documentUri) {
      return;
    }
    const html = await this.createExternalHtml(false);
    const tmpFile = path.join(os.tmpdir(), `markdown-index-preview-${Date.now()}.html`);
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
    const hljsThemeCssUri = this.resourceUri(webview, 'hljs-theme.css');
    const mermaidJsUri = this.resourceUri(webview, 'mermaid.min.js');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${cssUri}">
<link rel="stylesheet" href="${themeOverrideCssUri}">
<link rel="stylesheet" href="${hljsThemeCssUri}">
<script nonce="${nonce}" src="${mermaidJsUri}"></script>
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
    gap: 6px;
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
    padding: 4px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
  }
  .mi-toolbar button:hover {
    background-color: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2));
  }
  .mi-toolbar svg {
    display: block;
    flex-shrink: 0;
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
    <button id="mi-open-browser" title="View on External Browser">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
        <polyline points="15 3 21 3 21 9"></polyline>
        <line x1="10" y1="14" x2="21" y2="3"></line>
      </svg>
    </button>
    <button id="mi-print" title="Print / Save PDF">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="6 9 6 2 18 2 18 9"></polyline>
        <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path>
        <rect x="6" y="14" width="12" height="8"></rect>
      </svg>
    </button>
  </div>
  <article class="markdown-body" id="mi-content" data-theme="${resolvedTheme}">${bodyHtml}</article>
  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      const content = document.getElementById('mi-content');
      const sunIcon = document.getElementById('mi-icon-sun');
      const moonIcon = document.getElementById('mi-icon-moon');
      // Preserved so mermaid diagrams (which mermaid.run() destructively
      // replaces with rendered SVG) can be re-parsed from source whenever the
      // theme changes, without a round-trip to the extension host.
      let currentRawHtml = content.innerHTML;

      function mermaidThemeFor(theme) {
        return theme === 'dark' ? 'dark' : 'default';
      }

      async function renderMermaid(theme) {
        mermaid.initialize({ startOnLoad: false, theme: mermaidThemeFor(theme) });
        await mermaid.run({ querySelector: '#mi-content pre.mermaid' });
      }

      function updateThemeIcon(theme) {
        sunIcon.style.display = theme === 'dark' ? 'none' : 'block';
        moonIcon.style.display = theme === 'dark' ? 'block' : 'none';
      }
      updateThemeIcon(content.getAttribute('data-theme'));
      renderMermaid(content.getAttribute('data-theme'));

      document.getElementById('mi-theme-toggle').addEventListener('click', () => {
        const next = content.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        // Reset to the un-rendered markup before re-running mermaid, otherwise
        // it has no diagram source left to re-parse (it already became SVG).
        content.innerHTML = currentRawHtml;
        content.setAttribute('data-theme', next);
        updateThemeIcon(next);
        renderMermaid(next);
        vscode.postMessage({ type: 'setTheme', theme: next });
      });

      document.getElementById('mi-open-browser').addEventListener('click', () => {
        vscode.postMessage({ type: 'openInBrowser' });
      });

      document.getElementById('mi-print').addEventListener('click', () => {
        vscode.postMessage({ type: 'print' });
      });

      content.addEventListener('click', (event) => {
        const anchor = event.target.closest('a');
        if (!anchor) {
          return;
        }

        const href = anchor.getAttribute('href');
        if (!href) {
          return;
        }

        if (href.startsWith('#')) {
          event.preventDefault();
          const targetId = href.substring(1);
          const decodedId = decodeURIComponent(targetId);
          const targetEl = document.getElementById(decodedId) ||
                           document.getElementById(targetId) ||
                           document.querySelector('[id="' + CSS.escape(decodedId) + '"]');
          if (targetEl) {
            targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
          return;
        }

        if (/^(https?|mailto|vscode|command):/i.test(href)) {
          event.preventDefault();
          vscode.postMessage({ type: 'openExternal', href });
          return;
        }

        event.preventDefault();
        vscode.postMessage({ type: 'openLink', href });
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
          currentRawHtml = message.html;
          content.innerHTML = message.html;
          renderMermaid(content.getAttribute('data-theme'));
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
          content.innerHTML = currentRawHtml;
          content.setAttribute('data-theme', message.theme);
          renderMermaid(message.theme);
          updateThemeIcon(message.theme);
        }
      });
    }());
  </script>
</body>
</html>`;
  }

  private dispose(): void {
    if (this.documentUri) {
      const key = this.documentUri.toString();
      if (MarkdownPreviewPanel.panels.get(key) === this) {
        MarkdownPreviewPanel.panels.delete(key);
      }
    }
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      d?.dispose();
    }
  }
}
