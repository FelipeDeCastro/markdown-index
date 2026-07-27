import * as crypto from 'crypto';
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
import { parseHeadings, buildTree, HeadingNode } from './headingParser';

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
 * Resolves image src/srcset attributes in rendered HTML to either:
 * - Webview URIs (when `webview` is provided) for the VS Code custom preview panel.
 * - Absolute `file://` URIs (when `webview` is omitted) for external browser previews.
 */
function resolveImageSrcs(
  html: string,
  docUri: vscode.Uri,
  webview?: vscode.Webview,
): string {
  const baseDir = vscode.Uri.joinPath(docUri, '..');

  const resolveSingleUrl = (urlStr: string): string => {
    const trimmed = urlStr.trim();
    if (!trimmed || /^(https?|data|vscode-webview|vscode-file):/i.test(trimmed)) {
      return trimmed;
    }

    // Separate path from query/hash if present
    const match = trimmed.match(/^([^?#]*)(.*)$/);
    const pathPart = match ? match[1] : trimmed;
    const suffix = match ? match[2] : '';

    try {
      let imageUri: vscode.Uri;
      if (pathPart.startsWith('file://')) {
        imageUri = vscode.Uri.parse(pathPart);
      } else if (path.isAbsolute(pathPart) || pathPart.startsWith('/') || pathPart.startsWith('\\')) {
        imageUri = vscode.Uri.file(pathPart);
      } else {
        let decodedPath = pathPart;
        try {
          decodedPath = decodeURIComponent(pathPart);
        } catch {
          // Fall back to un-decoded path if percent-decoding fails
        }
        imageUri = vscode.Uri.joinPath(baseDir, decodedPath);
      }

      const resolvedBase = webview
        ? webview.asWebviewUri(imageUri).toString()
        : imageUri.toString();

      return resolvedBase + suffix;
    } catch {
      return trimmed;
    }
  };

  return html.replace(/<img\b([^>]*?)>/gi, (imgTag) => {
    return imgTag.replace(/\b(src|srcset)=["']([^"']+)["']/gi, (attrMatch, attrName, attrValue) => {
      if (attrName.toLowerCase() === 'srcset') {
        const resolvedSrcset = attrValue
          .split(',')
          .map((part: string) => {
            const trimmed = part.trim();
            const spaceIdx = trimmed.lastIndexOf(' ');
            if (spaceIdx > 0) {
              const url = trimmed.slice(0, spaceIdx);
              const descriptor = trimmed.slice(spaceIdx);
              return `${resolveSingleUrl(url)}${descriptor}`;
            }
            return resolveSingleUrl(trimmed);
          })
          .join(', ');
        return `${attrName}="${resolvedSrcset}"`;
      } else {
        return `${attrName}="${resolveSingleUrl(attrValue)}"`;
      }
    });
  });
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

  private static readonly _onDidChangeActivePreview = new vscode.EventEmitter<MarkdownPreviewPanel | undefined>();
  public static readonly onDidChangeActivePreview = MarkdownPreviewPanel._onDidChangeActivePreview.event;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly disposables: vscode.Disposable[] = [];
  private documentUri: vscode.Uri | undefined;
  private document: vscode.TextDocument | undefined;

  public getDocument(): vscode.TextDocument | undefined {
    return this.document;
  }

  public getDocumentUri(): vscode.Uri | undefined {
    return this.documentUri;
  }

  public getPanel(): vscode.WebviewPanel {
    return this.panel;
  }

  static getActivePreviewPanel(): MarkdownPreviewPanel | undefined {
    for (const instance of MarkdownPreviewPanel.panels.values()) {
      if (instance.panel.active) {
        return instance;
      }
    }
    return undefined;
  }

  static getAllPanels(): MarkdownPreviewPanel[] {
    return Array.from(MarkdownPreviewPanel.panels.values());
  }

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
      MarkdownPreviewPanel._onDidChangeActivePreview.fire(existing);
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
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'resources', 'preview'),
          ...(vscode.workspace.workspaceFolders?.map((f) => f.uri) ?? []),
          vscode.Uri.joinPath(document.uri, '..'),
          ...(document.uri.scheme === 'file' ? [vscode.Uri.file(path.parse(document.fileName).root)] : []),
        ],
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
    MarkdownPreviewPanel._onDidChangeActivePreview.fire(instance);
  }

  /** Re-renders the preview for the given document, if a panel for it is open. */
  static updateIfOpen(document: vscode.TextDocument): void {
    const current = MarkdownPreviewPanel.panels.get(document.uri.toString());
    if (current) {
      current.render(document);
      void current.updateExternalPreviewFile(document.uri);
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
    this.panel.onDidChangeViewState(
      () => {
        if (this.panel.active) {
          MarkdownPreviewPanel._onDidChangeActivePreview.fire(this);
        }
      },
      null,
      this.disposables,
    );
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
    this.document = document;
    this.documentUri = document.uri;
    this.panel.title = `Preview ${path.basename(document.fileName)}`;
    this.renderFull(document);
  }

  private render(document: vscode.TextDocument): void {
    const rawHtml = MarkdownPreviewPanel.md.render(document.getText());
    const html = resolveImageSrcs(rawHtml, document.uri, this.panel.webview);
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
  private async generateExternalPreview(
    docUri: vscode.Uri,
    autoPrint: boolean = false,
    visited: Set<string> = new Set(),
    depth: number = 0,
    maxDepth: number = 3,
  ): Promise<string> {
    const canonicalKey = docUri.toString();
    const tmpFileName = `md-preview-${crypto.createHash('sha256').update(canonicalKey).digest('hex').slice(0, 16)}.html`;
    const tmpPath = path.join(os.tmpdir(), tmpFileName);

    if (visited.has(canonicalKey)) {
      return tmpPath;
    }
    visited.add(canonicalKey);
    const doc = await vscode.workspace.openTextDocument(docUri);
    const rawText = doc.getText();
    const rawHtml = MarkdownPreviewPanel.md.render(rawText);
    const bodyHtml = resolveImageSrcs(rawHtml, docUri);
    const theme = vscode.workspace
      .getConfiguration('markdownIndex')
      .get<PreviewTheme>('previewTheme', 'auto');
    const resolvedTheme = autoPrint ? 'light' : resolveTheme(theme);

    const previewDir = vscode.Uri.joinPath(this.extensionUri, 'resources', 'preview').fsPath;
    const css = [
      fs.readFileSync(path.join(previewDir, 'github-markdown.css'), 'utf8'),
      fs.readFileSync(path.join(previewDir, 'theme-override.css'), 'utf8'),
      fs.readFileSync(path.join(previewDir, 'hljs-theme.css'), 'utf8'),
    ].join('\n');
    const mermaidJs = fs.readFileSync(path.join(previewDir, 'mermaid.min.js'), 'utf8');

    // Build TOC from parsed headings
    const headings = parseHeadings(rawText);
    const tocRoots = buildTree(headings);

    function renderTocItem(node: HeadingNode, minLevel: number): string {
      const indent = (node.level - minLevel) * 12;
      const childrenHtml = node.children.length > 0
        ? `<ul class="ext-toc-children">${node.children.map(c => renderTocItem(c, minLevel)).join('')}</ul>`
        : '';
      return `<li class="ext-toc-item" style="padding-left:${indent}px"><a class="ext-toc-link" data-line="${node.line}" data-text="${encodeURIComponent(node.text)}" href="#">${node.text}</a>${childrenHtml}</li>`;
    }

    const minLevel = headings.length > 0 ? Math.min(...headings.map(h => h.level)) : 1;
    const tocHtml = tocRoots.length > 0
      ? `<ul class="ext-toc-list">${tocRoots.map(n => renderTocItem(n, minLevel)).join('')}</ul>`
      : '<p class="ext-toc-empty">No headings found</p>';

    // Pre-generate external HTML previews for linked relative markdown documents (bounded by maxDepth)
    const linkMap: Record<string, string> = {};

    if (depth < maxDepth) {
      const rawMdLinkRegex = /\[[^\]]*\]\(([^)]+)\)/g;
      const htmlLinkRegex = /href=["']([^"']+)["']/gi;
      const hrefsToProcess = new Set<string>();

      let m: RegExpExecArray | null;
      while ((m = rawMdLinkRegex.exec(rawText)) !== null) {
        if (m[1]) hrefsToProcess.add(m[1].trim());
      }
      while ((m = htmlLinkRegex.exec(bodyHtml)) !== null) {
        if (m[1]) hrefsToProcess.add(m[1].trim());
      }

      for (const href of hrefsToProcess) {
        if (!href || href.startsWith('#') || /^(https?|mailto):/i.test(href)) {
          continue;
        }
        const [pathPart] = href.split('#');
        if (!pathPart) continue;

        try {
          const decodedPath = decodeURIComponent(pathPart);
          const baseDir = vscode.Uri.joinPath(docUri, '..');
          const targetUri = vscode.Uri.joinPath(baseDir, decodedPath);
          if (/\.(md|markdown|mdown|mkd)$/i.test(targetUri.fsPath)) {
            const stat = await vscode.workspace.fs.stat(targetUri);
            if (stat) {
              const targetTmpHtml = await this.generateExternalPreview(targetUri, false, visited, depth + 1, maxDepth);
              linkMap[href] = targetTmpHtml;
              linkMap[pathPart] = targetTmpHtml;
              linkMap[decodedPath] = targetTmpHtml;
              linkMap[targetUri.fsPath] = targetTmpHtml;
            }
          }
        } catch {
          // Skip unresolvable files
        }
      }
    }

    const htmlContent = `<!DOCTYPE html>
<html lang="en" data-theme="${resolvedTheme}">
<head>
<meta charset="UTF-8">
<title>${path.basename(doc.fileName)}</title>
<style>
${css}
html, body {
  margin: 0;
  padding: 0;
  height: 100vh;
  overflow: hidden;
  background-color: var(--bgColor-default, #ffffff);
  color: var(--fgColor-default, #1f2328);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
body {
  display: flex;
  flex-direction: row;
}
/* ── TOC panel ──────────────────────────────────────────── */
.ext-toc-panel {
  position: relative;
  height: 100vh;
  width: 240px;
  min-width: 240px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  background-color: var(--bgColor-muted, #f6f8fa);
  border-right: 1px solid var(--borderColor-default, #d1d9e0);
  z-index: 1000;
  transition: width 0.2s ease, min-width 0.2s ease;
  overflow: hidden;
  flex-shrink: 0;
}
.ext-toc-panel.collapsed {
  width: 48px !important;
  min-width: 48px !important;
}
.ext-toc-panel.collapsed #ext-toc-resize-handle {
  pointer-events: none;
}
.ext-toc-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 8px 8px 10px;
  border-bottom: 1px solid var(--borderColor-default, #d1d9e0);
  flex-shrink: 0;
}
.ext-toc-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  opacity: 0.6;
  white-space: nowrap;
  overflow: hidden;
  flex: 1;
  transition: opacity 0.15s ease;
}
.ext-toc-panel.collapsed .ext-toc-title {
  opacity: 0;
  pointer-events: none;
}
.ext-toc-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.ext-toc-panel.collapsed .ext-toc-actions {
  display: none;
}
.ext-icon-btn {
  background: transparent;
  border: 1px solid var(--borderColor-default, rgba(128,128,128,0.3));
  color: var(--fgColor-default, #24292f);
  border-radius: 6px;
  width: 28px;
  height: 28px;
  padding: 0;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color 0.15s ease, border-color 0.15s ease;
  flex-shrink: 0;
}
.ext-icon-btn:hover {
  background-color: var(--bgColor-neutral-muted, rgba(128,128,128,0.15));
}
.ext-icon-btn svg {
  display: block;
  flex-shrink: 0;
}
.ext-toc-toggle {
  background: transparent;
  border: none;
  color: var(--fgColor-default, #24292f);
  border-radius: 4px;
  width: 28px;
  height: 28px;
  padding: 0;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  opacity: 0.7;
  transition: opacity 0.15s ease, background-color 0.15s ease;
}
.ext-toc-toggle:hover {
  opacity: 1;
  background-color: var(--bgColor-neutral-muted, rgba(128,128,128,0.15));
}
.ext-toc-body {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 8px 0;
  scrollbar-width: thin;
}
.ext-toc-panel.collapsed .ext-toc-body {
  visibility: hidden;
}
.ext-toc-list,
.ext-toc-children {
  list-style: none;
  margin: 0;
  padding: 0;
}
.ext-toc-item {
  margin: 0;
}
.ext-toc-link {
  display: block;
  padding: 3px 12px 3px 12px;
  font-size: 13px;
  line-height: 1.4;
  color: var(--fgColor-default, #24292f);
  text-decoration: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  border-left: 2px solid transparent;
  transition: background-color 0.1s ease, border-color 0.1s ease, color 0.1s ease;
  opacity: 0.85;
}
.ext-toc-link:hover {
  background-color: var(--bgColor-neutral-muted, rgba(128,128,128,0.1));
  color: var(--fgColor-default, #24292f);
  opacity: 1;
}
.ext-toc-link.active {
  border-left-color: var(--fgColor-accent, #0969da);
  color: var(--fgColor-accent, #0969da);
  background-color: var(--bgColor-accent-muted, rgba(9,105,218,0.08));
  font-weight: 500;
  opacity: 1;
}
.ext-toc-empty {
  padding: 12px;
  font-size: 12px;
  opacity: 0.5;
  font-style: italic;
}
/* ── Main content ───────────────────────────────────────── */
.ext-container {
  flex: 1;
  min-width: 0;
  height: 100vh;
  overflow-y: auto;
}
.markdown-body {
  box-sizing: border-box;
  max-width: 900px;
  margin: 0 auto;
  padding: 32px 40px 64px;
}
@media print {
  html, body {
    height: auto !important;
    overflow: visible !important;
    display: block !important;
    background-color: #ffffff !important;
    color: #1f2328 !important;
  }
  .ext-toc-panel {
    display: none !important;
  }
  .ext-container {
    height: auto !important;
    overflow: visible !important;
    display: block !important;
  }
  .markdown-body {
    max-width: 100% !important;
    padding: 0 !important;
    margin: 0 auto !important;
    background-color: #ffffff !important;
    color: #1f2328 !important;
  }
  /* Enforce Light Theme variables during print regardless of dark data-theme */
  .markdown-body,
  .markdown-body[data-theme="dark"],
  .markdown-body[data-theme="light"] {
    color-scheme: light !important;
    --fgColor-default: #1f2328 !important;
    --fgColor-muted: #59636e !important;
    --fgColor-accent: #0969da !important;
    --fgColor-success: #1a7f37 !important;
    --fgColor-attention: #9a6700 !important;
    --fgColor-danger: #d1242f !important;
    --fgColor-done: #8250df !important;
    --bgColor-default: #ffffff !important;
    --bgColor-muted: #f6f8fa !important;
    --bgColor-neutral-muted: #818b981f !important;
    --bgColor-attention-muted: #fff8c5 !important;
    --borderColor-default: #d1d9e0 !important;
    --borderColor-muted: #d1d9e0b3 !important;
    --borderColor-neutral-muted: #d1d9e0b3 !important;
    --borderColor-accent-emphasis: #0969da !important;
    --borderColor-attention-emphasis: #9a6700 !important;
    --borderColor-danger-emphasis: #cf222e !important;
    --borderColor-done-emphasis: #8250df !important;
    --borderColor-success-emphasis: #1a7f37 !important;
  }
  .markdown-body code,
  .markdown-body tt {
    color: #1f2328 !important;
    background-color: #818b981f !important;
  }
  /* Enforce Light Theme for syntax highlighting (highlight.js) */
  .markdown-body[data-theme="dark"] .hljs {
    color: #24292e !important;
    background: #ffffff !important;
  }
  .markdown-body[data-theme="dark"] .hljs-doctag,
  .markdown-body[data-theme="dark"] .hljs-keyword,
  .markdown-body[data-theme="dark"] .hljs-meta .hljs-keyword,
  .markdown-body[data-theme="dark"] .hljs-template-tag,
  .markdown-body[data-theme="dark"] .hljs-template-variable,
  .markdown-body[data-theme="dark"] .hljs-type,
  .markdown-body[data-theme="dark"] .hljs-variable.language_ {
    color: #d73a49 !important;
  }
  .markdown-body[data-theme="dark"] .hljs-title,
  .markdown-body[data-theme="dark"] .hljs-title.class_,
  .markdown-body[data-theme="dark"] .hljs-title.class_.inherited__,
  .markdown-body[data-theme="dark"] .hljs-title.function_ {
    color: #6f42c1 !important;
  }
  .markdown-body[data-theme="dark"] .hljs-attr,
  .markdown-body[data-theme="dark"] .hljs-attribute,
  .markdown-body[data-theme="dark"] .hljs-literal,
  .markdown-body[data-theme="dark"] .hljs-meta,
  .markdown-body[data-theme="dark"] .hljs-number,
  .markdown-body[data-theme="dark"] .hljs-operator,
  .markdown-body[data-theme="dark"] .hljs-variable,
  .markdown-body[data-theme="dark"] .hljs-selector-attr,
  .markdown-body[data-theme="dark"] .hljs-selector-class,
  .markdown-body[data-theme="dark"] .hljs-selector-id {
    color: #005cc5 !important;
  }
  .markdown-body[data-theme="dark"] .hljs-regexp,
  .markdown-body[data-theme="dark"] .hljs-string,
  .markdown-body[data-theme="dark"] .hljs-meta .hljs-string {
    color: #032f62 !important;
  }
  .markdown-body[data-theme="dark"] .hljs-built_in,
  .markdown-body[data-theme="dark"] .hljs-symbol {
    color: #e36209 !important;
  }
  .markdown-body[data-theme="dark"] .hljs-comment,
  .markdown-body[data-theme="dark"] .hljs-code,
  .markdown-body[data-theme="dark"] .hljs-formula {
    color: #6a737d !important;
  }
  .markdown-body[data-theme="dark"] .hljs-name,
  .markdown-body[data-theme="dark"] .hljs-quote,
  .markdown-body[data-theme="dark"] .hljs-selector-tag,
  .markdown-body[data-theme="dark"] .hljs-selector-pseudo {
    color: #22863a !important;
  }
  .markdown-body[data-theme="dark"] .hljs-subst {
    color: #24292e !important;
  }
  .markdown-body[data-theme="dark"] .hljs-section {
    color: #005cc5 !important;
  }
  .markdown-body[data-theme="dark"] .hljs-bullet {
    color: #735c0f !important;
  }
  .markdown-body[data-theme="dark"] .hljs-emphasis {
    color: #24292e !important;
  }
  .markdown-body[data-theme="dark"] .hljs-strong {
    color: #24292e !important;
  }
  .markdown-body[data-theme="dark"] .hljs-addition {
    color: #22863a !important;
    background-color: #f0fff4 !important;
  }
  .markdown-body[data-theme="dark"] .hljs-deletion {
    color: #b31d28 !important;
    background-color: #ffeef0 !important;
  }
  pre, code, table, blockquote, img, svg, .mermaid {
    break-inside: avoid;
    page-break-inside: avoid;
  }
  h1, h2, h3, h4, h5, h6 {
    break-after: avoid;
    page-break-after: avoid;
  }
}
/* ── Resize handle ──────────────────────────────────────── */
.ext-toc-resize-handle {
  position: absolute;
  top: 0;
  right: 0;
  width: 5px;
  height: 100%;
  cursor: col-resize;
  z-index: 10;
  background: transparent;
  transition: background 0.15s ease;
}
.ext-toc-resize-handle:hover,
.ext-toc-resize-handle.dragging {
  background: var(--fgColor-accent, #0969da);
  opacity: 0.35;
}
</style>
</head>
<body>
  <nav class="ext-toc-panel" id="ext-toc-panel" aria-label="Table of contents">
    <div class="ext-toc-resize-handle" id="ext-toc-resize-handle" aria-hidden="true"></div>
    <div class="ext-toc-header">
      <button class="ext-toc-toggle" id="ext-toc-toggle" title="Toggle table of contents" aria-label="Toggle table of contents">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="3" y1="6" x2="21" y2="6"></line>
          <line x1="3" y1="12" x2="21" y2="12"></line>
          <line x1="3" y1="18" x2="21" y2="18"></line>
        </svg>
      </button>
      <span class="ext-toc-title">Index</span>
      <div class="ext-toc-actions">
        <button id="ext-theme-toggle" class="ext-icon-btn" title="Toggle light/dark theme" aria-label="Toggle light/dark theme">
          <svg id="ext-icon-sun" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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
          <svg id="ext-icon-moon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
          </svg>
        </button>
        <button id="ext-print" class="ext-icon-btn" title="Print / Save PDF" aria-label="Print or save as PDF">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 6 2 18 2 18 9"></polyline>
            <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path>
            <rect x="6" y="14" width="12" height="8"></rect>
          </svg>
        </button>
      </div>
    </div>
    <div class="ext-toc-body">
      ${tocHtml}
    </div>
  </nav>
  <main class="ext-container">
    <article class="markdown-body" id="ext-content" data-theme="${resolvedTheme}">${bodyHtml}</article>
  </main>
<script>${mermaidJs}</script>
<script>
  // Register click handlers synchronously so they always work even if mermaid fails
  (function () {
    const content = document.getElementById('ext-content');
    const tocPanel = document.getElementById('ext-toc-panel');
    const linkMap = ${JSON.stringify(linkMap)};

    // ── TOC panel collapse/expand ────────────────────────────
    const TOC_COLLAPSED_KEY = 'md-index-toc-collapsed';
    const TOC_WIDTH_KEY = 'md-index-toc-width';
    function applyTocState(collapsed) {
      if (collapsed) {
        tocPanel.classList.add('collapsed');
        tocPanel.style.width = '';
        tocPanel.style.minWidth = '';
      } else {
        tocPanel.classList.remove('collapsed');
        const w = parseInt(localStorage.getItem(TOC_WIDTH_KEY) || '0', 10);
        if (w >= 160) {
          tocPanel.style.width = w + 'px';
          tocPanel.style.minWidth = w + 'px';
        }
      }
    }
    const initCollapsed = localStorage.getItem(TOC_COLLAPSED_KEY) === 'true';
    applyTocState(initCollapsed);

    // Restore persisted width (only when not collapsed)
    const savedWidth = parseInt(localStorage.getItem(TOC_WIDTH_KEY) || '0', 10);
    if (savedWidth >= 160 && !initCollapsed) {
      tocPanel.style.width = savedWidth + 'px';
      tocPanel.style.minWidth = savedWidth + 'px';
    }

    document.getElementById('ext-toc-toggle').addEventListener('click', () => {
      const nowCollapsed = !tocPanel.classList.contains('collapsed');
      applyTocState(nowCollapsed);
      localStorage.setItem(TOC_COLLAPSED_KEY, String(nowCollapsed));
    });

    // ── TOC panel resize ─────────────────────────────────────
    const resizeHandle = document.getElementById('ext-toc-resize-handle');
    let isResizing = false;
    let resizeStartX = 0;
    let resizeStartWidth = 0;
    resizeHandle.addEventListener('mousedown', (e) => {
      if (tocPanel.classList.contains('collapsed')) return;
      isResizing = true;
      resizeStartX = e.clientX;
      resizeStartWidth = tocPanel.offsetWidth;
      resizeHandle.classList.add('dragging');
      // Disable transition during drag for snappy feel
      tocPanel.style.transition = 'none';
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      const delta = e.clientX - resizeStartX;
      const newWidth = Math.max(160, Math.min(600, resizeStartWidth + delta));
      tocPanel.style.width = newWidth + 'px';
      tocPanel.style.minWidth = newWidth + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!isResizing) return;
      isResizing = false;
      resizeHandle.classList.remove('dragging');
      tocPanel.style.transition = '';
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem(TOC_WIDTH_KEY, String(tocPanel.offsetWidth));
    });

    // ── Active TOC link tracking (scroll spy) ────────────────
    const tocLinks = Array.from(document.querySelectorAll('.ext-toc-link'));
    function updateActiveTocLink() {
      const headingEls = Array.from(content.querySelectorAll('h1,h2,h3,h4,h5,h6'));
      let active = null;
      const container = document.querySelector('.ext-container');
      const scrollTop = container.scrollTop;
      for (const el of headingEls) {
        if (el.offsetTop <= scrollTop + 80) {
          active = el;
        }
      }
      const activeLine = active ? active.getAttribute('data-line') : null;
      for (const link of tocLinks) {
        if (activeLine && link.getAttribute('data-line') === activeLine) {
          link.classList.add('active');
        } else {
          link.classList.remove('active');
        }
      }
    }
    const container = document.querySelector('.ext-container');
    if (container) {
      container.addEventListener('scroll', updateActiveTocLink, { passive: true });
    }
    updateActiveTocLink();

    // ── TOC link smooth scroll ───────────────────────────────
    for (const link of tocLinks) {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        const line = link.getAttribute('data-line');
        let targetEl = line ? content.querySelector('[data-line="' + line + '"]') : null;
        if (!targetEl) {
          const text = decodeURIComponent(link.getAttribute('data-text') || '');
          const headings = Array.from(content.querySelectorAll('h1,h2,h3,h4,h5,h6'));
          targetEl = headings.find(h => h.textContent.trim() === text);
        }
        if (targetEl) {
          targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    }

    // ── Print button ─────────────────────────────────────────
    document.getElementById('ext-print').addEventListener('click', () => {
      window.print();
    });

    // ── Content link navigation ──────────────────────────────
    content.addEventListener('click', (event) => {
      const anchor = event.target.closest('a');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href) return;

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

      if (/^(https?|mailto):/i.test(href)) {
        return;
      }

      event.preventDefault();
      const currentDir = ${JSON.stringify(path.dirname(doc.fileName))};
      const cleanHref = href.split('#')[0];
      const hashPart = href.includes('#') ? '#' + href.split('#')[1] : '';
      if (!cleanHref) return;

      console.log('[md-index] click href:', href, 'cleanHref:', cleanHref, 'linkMap keys:', Object.keys(linkMap));

      if (linkMap[href] || linkMap[cleanHref] || linkMap[decodeURIComponent(cleanHref)]) {
        const targetHtml = linkMap[href] || linkMap[cleanHref] || linkMap[decodeURIComponent(cleanHref)];
        window.location.href = 'file://' + targetHtml + hashPart;
        return;
      }

      const pathParts = (currentDir + '/' + decodeURIComponent(cleanHref)).split(/[\\\/]/);
      const stack = [];
      for (const part of pathParts) {
        if (part === '' || part === '.') continue;
        if (part === '..') {
          if (stack.length > 0) stack.pop();
        } else {
          stack.push(part);
        }
      }
      const absolutePath = (currentDir.startsWith('/') ? '/' : '') + stack.join('/');

      if (linkMap[absolutePath]) {
        window.location.href = 'file://' + linkMap[absolutePath] + hashPart;
        return;
      }

      const isMarkdown = /\.(md|markdown|mdown|mkd)$/i.test(absolutePath);
      if (isMarkdown) {
        const canonicalKey = 'file://' + (absolutePath.startsWith('/') ? '' : '/') + absolutePath.split('/').map(encodeURIComponent).join('/');
        let hex = '';
        for (let i = 0; i < canonicalKey.length; i++) {
          hex += canonicalKey.charCodeAt(i).toString(16).padStart(2, '0');
        }
        const hash = hex.slice(0, 16);
        const tmpDir = ${JSON.stringify(os.tmpdir())};
        const targetHtmlPath = tmpDir + '/md-preview-' + hash + '.html';
        window.location.href = 'file://' + targetHtmlPath + hashPart;
      } else {
        window.location.href = 'file://' + absolutePath + hashPart;
      }
    });
  }());

  // Async mermaid + theme initialisation (runs independently from click handlers)
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
      try {
        mermaid.initialize({ startOnLoad: false, theme: mermaidThemeFor(theme) });
        await mermaid.run({ querySelector: '#ext-content pre.mermaid' });
      } catch (_) {}
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

    let prePrintTheme = null;
    window.addEventListener('beforeprint', async () => {
      const currentTheme = content.getAttribute('data-theme');
      if (currentTheme === 'dark') {
        prePrintTheme = 'dark';
        content.innerHTML = rawHtml;
        updateTheme('light');
        await renderMermaid('light');
      }
    });
    window.addEventListener('afterprint', async () => {
      if (prePrintTheme === 'dark') {
        prePrintTheme = null;
        content.innerHTML = rawHtml;
        updateTheme('dark');
        await renderMermaid('dark');
      }
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

    fs.writeFileSync(tmpPath, htmlContent, 'utf8');
    return tmpPath;
  }

  private async updateExternalPreviewFile(docUri: vscode.Uri): Promise<void> {
    const hash = crypto.createHash('sha256').update(docUri.toString()).digest('hex').slice(0, 16);
    const tmpPath = path.join(os.tmpdir(), `md-preview-${hash}.html`);
    if (fs.existsSync(tmpPath)) {
      await this.generateExternalPreview(docUri, false);
    }
  }

  private async printCurrentDocument(): Promise<void> {
    if (!this.documentUri) {
      return;
    }
    const mainHtmlPath = await this.generateExternalPreview(this.documentUri, true);
    await vscode.env.openExternal(vscode.Uri.file(mainHtmlPath));
  }

  private async openInBrowser(): Promise<void> {
    if (!this.documentUri) {
      vscode.window.showErrorMessage('[md-index] openInBrowser: documentUri is not set');
      return;
    }
    try {
      const mainHtmlPath = await this.generateExternalPreview(this.documentUri);
      await vscode.env.openExternal(vscode.Uri.file(mainHtmlPath));
    } catch (err) {
      vscode.window.showErrorMessage(`[md-index] openInBrowser error: ${err}`);
    }
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
    const rawHtml = MarkdownPreviewPanel.md.render(document.getText());
    const html = resolveImageSrcs(rawHtml, document.uri, this.panel.webview);
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: http: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
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
    html, body {
      height: auto !important;
      overflow: visible !important;
      display: block !important;
      background-color: #ffffff !important;
      color: #1f2328 !important;
    }
    .mi-toolbar {
      display: none !important;
    }
    .markdown-body {
      max-width: 100% !important;
      padding: 0 !important;
      margin: 0 auto !important;
      background-color: #ffffff !important;
      color: #1f2328 !important;
    }
    /* Enforce Light Theme variables during print regardless of dark data-theme */
    .markdown-body,
    .markdown-body[data-theme="dark"],
    .markdown-body[data-theme="light"] {
      color-scheme: light !important;
      --fgColor-default: #1f2328 !important;
      --fgColor-muted: #59636e !important;
      --fgColor-accent: #0969da !important;
      --fgColor-success: #1a7f37 !important;
      --fgColor-attention: #9a6700 !important;
      --fgColor-danger: #d1242f !important;
      --fgColor-done: #8250df !important;
      --bgColor-default: #ffffff !important;
      --bgColor-muted: #f6f8fa !important;
      --bgColor-neutral-muted: #818b981f !important;
      --bgColor-attention-muted: #fff8c5 !important;
      --borderColor-default: #d1d9e0 !important;
      --borderColor-muted: #d1d9e0b3 !important;
      --borderColor-neutral-muted: #d1d9e0b3 !important;
      --borderColor-accent-emphasis: #0969da !important;
      --borderColor-attention-emphasis: #9a6700 !important;
      --borderColor-danger-emphasis: #cf222e !important;
      --borderColor-done-emphasis: #8250df !important;
      --borderColor-success-emphasis: #1a7f37 !important;
    }
    .markdown-body code,
    .markdown-body tt {
      color: #1f2328 !important;
      background-color: #818b981f !important;
    }
    /* Enforce Light Theme for syntax highlighting (highlight.js) */
    .markdown-body[data-theme="dark"] .hljs {
      color: #24292e !important;
      background: #ffffff !important;
    }
    .markdown-body[data-theme="dark"] .hljs-doctag,
    .markdown-body[data-theme="dark"] .hljs-keyword,
    .markdown-body[data-theme="dark"] .hljs-meta .hljs-keyword,
    .markdown-body[data-theme="dark"] .hljs-template-tag,
    .markdown-body[data-theme="dark"] .hljs-template-variable,
    .markdown-body[data-theme="dark"] .hljs-type,
    .markdown-body[data-theme="dark"] .hljs-variable.language_ {
      color: #d73a49 !important;
    }
    .markdown-body[data-theme="dark"] .hljs-title,
    .markdown-body[data-theme="dark"] .hljs-title.class_,
    .markdown-body[data-theme="dark"] .hljs-title.class_.inherited__,
    .markdown-body[data-theme="dark"] .hljs-title.function_ {
      color: #6f42c1 !important;
    }
    .markdown-body[data-theme="dark"] .hljs-attr,
    .markdown-body[data-theme="dark"] .hljs-attribute,
    .markdown-body[data-theme="dark"] .hljs-literal,
    .markdown-body[data-theme="dark"] .hljs-meta,
    .markdown-body[data-theme="dark"] .hljs-number,
    .markdown-body[data-theme="dark"] .hljs-operator,
    .markdown-body[data-theme="dark"] .hljs-variable,
    .markdown-body[data-theme="dark"] .hljs-selector-attr,
    .markdown-body[data-theme="dark"] .hljs-selector-class,
    .markdown-body[data-theme="dark"] .hljs-selector-id {
      color: #005cc5 !important;
    }
    .markdown-body[data-theme="dark"] .hljs-regexp,
    .markdown-body[data-theme="dark"] .hljs-string,
    .markdown-body[data-theme="dark"] .hljs-meta .hljs-string {
      color: #032f62 !important;
    }
    .markdown-body[data-theme="dark"] .hljs-built_in,
    .markdown-body[data-theme="dark"] .hljs-symbol {
      color: #e36209 !important;
    }
    .markdown-body[data-theme="dark"] .hljs-comment,
    .markdown-body[data-theme="dark"] .hljs-code,
    .markdown-body[data-theme="dark"] .hljs-formula {
      color: #6a737d !important;
    }
    .markdown-body[data-theme="dark"] .hljs-name,
    .markdown-body[data-theme="dark"] .hljs-quote,
    .markdown-body[data-theme="dark"] .hljs-selector-tag,
    .markdown-body[data-theme="dark"] .hljs-selector-pseudo {
      color: #22863a !important;
    }
    .markdown-body[data-theme="dark"] .hljs-subst {
      color: #24292e !important;
    }
    .markdown-body[data-theme="dark"] .hljs-section {
      color: #005cc5 !important;
    }
    .markdown-body[data-theme="dark"] .hljs-bullet {
      color: #735c0f !important;
    }
    .markdown-body[data-theme="dark"] .hljs-emphasis {
      color: #24292e !important;
    }
    .markdown-body[data-theme="dark"] .hljs-strong {
      color: #24292e !important;
    }
    .markdown-body[data-theme="dark"] .hljs-addition {
      color: #22863a !important;
      background-color: #f0fff4 !important;
    }
    .markdown-body[data-theme="dark"] .hljs-deletion {
      color: #b31d28 !important;
      background-color: #ffeef0 !important;
    }
    pre, code, table, blockquote, img, svg, .mermaid {
      break-inside: avoid;
      page-break-inside: avoid;
    }
    h1, h2, h3, h4, h5, h6 {
      break-after: avoid;
      page-break-after: avoid;
    }
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
    MarkdownPreviewPanel._onDidChangeActivePreview.fire(MarkdownPreviewPanel.getActivePreviewPanel());
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      d?.dispose();
    }
  }
}
