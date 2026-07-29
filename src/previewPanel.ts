import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
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

/** Formats a Date as an exact, locale-aware timestamp down to the minute (e.g. "Jul 29, 2026, 4:32 PM"). */
function formatExactTimestamp(date: Date): string {
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface GitFileInfo {
  githubUrl?: string;
  branch?: string;
  /** true = local matches last-known remote state, false = diverged/uncommitted, undefined = unknown (e.g. no upstream). */
  inSync?: boolean;
  syncDetail: string;
}

/** Runs a git command, returning trimmed stdout, or null if it fails (e.g. not a repo, git not installed). */
function runGit(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, { cwd, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString('utf8')
      .trim();
  } catch {
    return null;
  }
}

/** Converts a git remote URL (SSH or HTTPS) into a github.com https base URL, or null if not GitHub. */
function githubBaseUrlFromRemote(remoteUrl: string): string | null {
  const sshMatch = remoteUrl.match(/^git@github\.com:(.+?)(\.git)?$/);
  if (sshMatch) {
    return `https://github.com/${sshMatch[1]}`;
  }
  const httpsMatch = remoteUrl.match(/^https?:\/\/github\.com\/(.+?)(\.git)?$/);
  if (httpsMatch) {
    return `https://github.com/${httpsMatch[1]}`;
  }
  return null;
}

/**
 * Looks up the file's GitHub location (if the repo has a github.com origin remote)
 * and whether the local working copy is in sync with the last-known remote state.
 * Never performs a network fetch — "in sync" is relative to the last time the
 * remote-tracking ref was updated (e.g. by a manual `git fetch`/`pull`).
 */
function getGitFileInfo(filePath: string): GitFileInfo | null {
  const cwd = path.dirname(filePath);
  const repoRoot = runGit(['rev-parse', '--show-toplevel'], cwd);
  if (!repoRoot) {
    return null;
  }

  const remoteUrl = runGit(['config', '--get', 'remote.origin.url'], cwd);
  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd) || undefined;
  const relPath = path.relative(repoRoot, filePath).split(path.sep).join('/');

  const info: GitFileInfo = { branch, syncDetail: 'Not tracked by a GitHub remote' };

  if (remoteUrl) {
    const base = githubBaseUrlFromRemote(remoteUrl);
    if (base && branch && branch !== 'HEAD') {
      const encodedPath = relPath.split('/').map(encodeURIComponent).join('/');
      info.githubUrl = `${base}/blob/${encodeURIComponent(branch)}/${encodedPath}`;
    }
  }

  const statusOut = runGit(['status', '--porcelain', '--', relPath], repoRoot);
  const hasLocalChanges = !!statusOut;
  const localHead = runGit(['rev-parse', 'HEAD'], cwd);
  const upstreamHead = runGit(['rev-parse', '@{u}'], cwd);

  if (hasLocalChanges) {
    info.inSync = false;
    info.syncDetail = 'Uncommitted local changes';
  } else if (upstreamHead === null) {
    info.inSync = undefined;
    info.syncDetail = 'No upstream branch configured';
  } else if (localHead && localHead === upstreamHead) {
    info.inSync = true;
    info.syncDetail = `Up to date with origin/${branch} (as of last fetch)`;
  } else {
    info.inSync = false;
    info.syncDetail = `Local commit differs from origin/${branch} (as of last fetch)`;
  }

  return info;
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
  private static async generateExternalPreview(
    extensionUri: vscode.Uri,
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
    const fileName = path.basename(doc.fileName);
    const rawText = doc.getText();
    const rawHtml = MarkdownPreviewPanel.md.render(rawText);
    const bodyHtml = resolveImageSrcs(rawHtml, docUri);
    const theme = vscode.workspace
      .getConfiguration('markdownIndex')
      .get<PreviewTheme>('previewTheme', 'auto');
    const resolvedTheme = autoPrint ? 'light' : resolveTheme(theme);

    const lastUpdatedText = formatExactTimestamp(fs.statSync(doc.fileName).mtime);
    const sourcePath = doc.fileName;
    const gitInfo = getGitFileInfo(doc.fileName);

    const previewDir = vscode.Uri.joinPath(extensionUri, 'resources', 'preview').fsPath;
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
      const hasChildren = node.children.length > 0;
      const childrenHtml = hasChildren
        ? `<ul class="ext-toc-children">${node.children.map(c => renderTocItem(c, minLevel)).join('')}</ul>`
        : '';
      const twisty = hasChildren
        ? `<button class="ext-toc-twisty" aria-label="Toggle" aria-expanded="true">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M10.072 8.024L5.715 12.38l-.618-.618 3.62-3.738-3.62-3.738.618-.618 4.357 4.357z"></path></svg>
          </button>`
        : '<span class="ext-toc-twisty-spacer"></span>';
      return `<li class="ext-toc-item" style="padding-left:${indent}px"><div class="ext-toc-row">${twisty}<a class="ext-toc-link" data-line="${node.line}" data-text="${encodeURIComponent(node.text)}" href="#">${node.text}</a></div>${childrenHtml}</li>`;
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
              const targetTmpHtml = await MarkdownPreviewPanel.generateExternalPreview(extensionUri, targetUri, false, visited, depth + 1, maxDepth);
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

    const escapeHtml = (s: string) => MarkdownPreviewPanel.md.utils.escapeHtml(s);
    const githubRowHtml = gitInfo && gitInfo.githubUrl
      ? `<div class="ext-info-row"><span class="ext-info-label">GitHub</span><a class="ext-info-value ext-info-link" href="${gitInfo.githubUrl}" target="_blank" rel="noopener noreferrer">View on GitHub ↗</a></div>`
      : '';
    const syncClass = !gitInfo ? 'unknown' : gitInfo.inSync === true ? 'ok' : gitInfo.inSync === false ? 'diverged' : 'unknown';
    const syncLabel = !gitInfo ? '● Not a git repository' : gitInfo.inSync === true ? '● In sync' : gitInfo.inSync === false ? '● Out of sync' : '● Unknown';
    const syncDetail = gitInfo ? gitInfo.syncDetail : 'This file is not inside a git repository';
    const syncRowHtml = `<div class="ext-info-row"><span class="ext-info-label">Sync status</span><span class="ext-info-value ext-info-sync ext-info-sync-${syncClass}" title="${escapeHtml(syncDetail)}">${syncLabel}</span></div>`;

    const infoModalHtml = `
  <div class="ext-info-modal-overlay" id="ext-info-overlay">
    <div class="ext-info-modal" role="dialog" aria-modal="true" aria-labelledby="ext-info-title">
      <div class="ext-info-modal-header">
        <span id="ext-info-title">File Information</span>
        <button class="ext-info-modal-close" id="ext-info-close" aria-label="Close">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 8.707l3.646 3.647.708-.708L8.707 8l3.647-3.646-.708-.708L8 7.293 4.354 3.646l-.708.708L7.293 8l-3.647 3.646.708.708L8 8.707z"></path></svg>
        </button>
      </div>
      <div class="ext-info-modal-body">
        <div class="ext-info-row">
          <span class="ext-info-label">Last updated</span>
          <span class="ext-info-value">${escapeHtml(lastUpdatedText)}</span>
        </div>
        <div class="ext-info-row">
          <span class="ext-info-label">Source file</span>
          <span class="ext-info-value ext-info-path">${escapeHtml(sourcePath)}</span>
        </div>
        ${githubRowHtml}
        ${syncRowHtml}
      </div>
    </div>
  </div>
`;

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
.ext-toc-item.collapsed > .ext-toc-children {
  display: none;
}
.ext-toc-row {
  display: flex;
  align-items: center;
  gap: 2px;
}
.ext-toc-twisty,
.ext-toc-twisty-spacer {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
}
.ext-toc-twisty {
  background: transparent;
  border: none;
  padding: 0;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--fgColor-muted, #59636e);
  opacity: 0.8;
}
.ext-toc-twisty:hover {
  opacity: 1;
}
.ext-toc-twisty svg {
  display: block;
  transform: rotate(90deg);
  transition: transform 0.1s ease;
}
.ext-toc-item.collapsed > .ext-toc-row .ext-toc-twisty svg {
  transform: rotate(0deg);
}
.ext-toc-link {
  display: block;
  flex: 1;
  min-width: 0;
  padding: 3px 12px 3px 0;
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
  color: var(--fgColor-accent, #0969da);
  font-weight: 500;
}
.ext-toc-empty {
  padding: 12px;
  font-size: 12px;
  opacity: 0.5;
  font-style: italic;
}
/* ── Info modal ────────────────────────────────────────── */
.ext-info-modal-overlay {
  display: none;
  position: fixed;
  inset: 0;
  background-color: rgba(0, 0, 0, 0.5);
  z-index: 2000;
  align-items: center;
  justify-content: center;
}
.ext-info-modal-overlay.visible {
  display: flex;
}
.ext-info-modal {
  background-color: var(--bgColor-default, #ffffff);
  color: var(--fgColor-default, #1f2328);
  border: 1px solid var(--borderColor-default, #d1d9e0);
  border-radius: 8px;
  width: 420px;
  max-width: calc(100vw - 48px);
  max-height: calc(100vh - 48px);
  overflow: auto;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
}
.ext-info-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--borderColor-default, #d1d9e0);
  font-size: 14px;
  font-weight: 600;
}
.ext-info-modal-close {
  background: transparent;
  border: none;
  color: var(--fgColor-default, #24292f);
  cursor: pointer;
  padding: 2px;
  border-radius: 4px;
  display: flex;
  opacity: 0.7;
}
.ext-info-modal-close:hover {
  opacity: 1;
  background-color: var(--bgColor-neutral-muted, rgba(128, 128, 128, 0.15));
}
.ext-info-modal-body {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ext-info-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ext-info-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.6;
}
.ext-info-value {
  font-size: 13px;
  word-break: break-all;
}
.ext-info-value.ext-info-path {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.ext-info-link {
  color: var(--fgColor-accent, #0969da);
  text-decoration: none;
}
.ext-info-link:hover {
  text-decoration: underline;
}
.ext-info-sync-ok {
  color: var(--fgColor-success, #1a7f37);
}
.ext-info-sync-diverged {
  color: var(--fgColor-danger, #d1242f);
}
.ext-info-sync-unknown {
  color: var(--fgColor-muted, #59636e);
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
  .ext-info-modal-overlay {
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
      <span class="ext-toc-title" title="${MarkdownPreviewPanel.md.utils.escapeHtml(fileName)}">${MarkdownPreviewPanel.md.utils.escapeHtml(fileName)}</span>
      <div class="ext-toc-actions">
        <button id="ext-theme-toggle" class="ext-icon-btn" title="Toggle light/dark theme" aria-label="Toggle light/dark theme">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1.00195C6.61553 1.00195 5.26216 1.4125 4.11101 2.18167C2.95987 2.95084 2.06266 4.04409 1.53285 5.32317C1.00303 6.60225 0.864412 8.00972 1.13451 9.36759C1.4046 10.7255 2.07129 11.9727 3.05026 12.9517C4.02922 13.9307 5.27651 14.5974 6.63437 14.8675C7.99224 15.1375 9.3997 14.9989 10.6788 14.4691C11.9579 13.9393 13.0511 13.0421 13.8203 11.8909C14.5895 10.7398 15 9.38642 15 8.00195C15 6.14544 14.2625 4.36496 12.9498 3.05221C11.637 1.73945 9.85652 1.00195 8 1.00195ZM8 14.002V2.00195C9.5913 2.00195 11.1174 2.63409 12.2426 3.75931C13.3679 4.88453 14 6.41065 14 8.00195C14 9.59325 13.3679 11.1194 12.2426 12.2446C11.1174 13.3698 9.5913 14.002 8 14.002Z"></path>
          </svg>
        </button>
        <button id="ext-print" class="ext-icon-btn" title="Print / Save PDF" aria-label="Print or save as PDF">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 6 2 18 2 18 9"></polyline>
            <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path>
            <rect x="6" y="14" width="12" height="8"></rect>
          </svg>
        </button>
        <button id="ext-info" class="ext-icon-btn" title="File information" aria-label="File information">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8.49902 7.49998C8.49902 7.22384 8.27517 6.99998 7.99902 6.99998C7.72288 6.99998 7.49902 7.22384 7.49902 7.49998V10.5C7.49902 10.7761 7.72288 11 7.99902 11C8.27517 11 8.49902 10.7761 8.49902 10.5V7.49998ZM8.74807 5.50001C8.74807 5.91369 8.41271 6.24905 7.99903 6.24905C7.58535 6.24905 7.25 5.91369 7.25 5.50001C7.25 5.08633 7.58535 4.75098 7.99903 4.75098C8.41271 4.75098 8.74807 5.08633 8.74807 5.50001ZM8 1C4.13401 1 1 4.13401 1 8C1 11.866 4.13401 15 8 15C11.866 15 15 11.866 15 8C15 4.13401 11.866 1 8 1ZM2 8C2 4.68629 4.68629 2 8 2C11.3137 2 14 4.68629 14 8C14 11.3137 11.3137 14 8 14C4.68629 14 2 11.3137 2 8Z"></path>
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
  ${infoModalHtml}
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

    // ── TOC item collapse/expand (twisty) ────────────────────
    document.querySelectorAll('.ext-toc-twisty').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const item = btn.closest('.ext-toc-item');
        const nowCollapsed = !item.classList.contains('collapsed');
        item.classList.toggle('collapsed', nowCollapsed);
        btn.setAttribute('aria-expanded', String(!nowCollapsed));
      });
    });
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

    // ── Info modal ────────────────────────────────────────────
    const infoOverlay = document.getElementById('ext-info-overlay');
    const infoBtn = document.getElementById('ext-info');
    const infoClose = document.getElementById('ext-info-close');
    function openInfoModal() {
      if (infoOverlay) infoOverlay.classList.add('visible');
    }
    function closeInfoModal() {
      if (infoOverlay) infoOverlay.classList.remove('visible');
    }
    if (infoBtn) {
      infoBtn.addEventListener('click', openInfoModal);
    }
    if (infoClose) {
      infoClose.addEventListener('click', closeInfoModal);
    }
    if (infoOverlay) {
      infoOverlay.addEventListener('click', (event) => {
        if (event.target === infoOverlay) closeInfoModal();
      });
    }
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && infoOverlay && infoOverlay.classList.contains('visible')) {
        closeInfoModal();
      }
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
      await MarkdownPreviewPanel.generateExternalPreview(this.extensionUri, docUri, false);
    }
  }

  private async printCurrentDocument(): Promise<void> {
    if (!this.documentUri) {
      return;
    }
    const mainHtmlPath = await MarkdownPreviewPanel.generateExternalPreview(this.extensionUri, this.documentUri, true);
    await vscode.env.openExternal(vscode.Uri.file(mainHtmlPath));
  }

  static async openInBrowser(extensionUri: vscode.Uri, docUri: vscode.Uri): Promise<void> {
    try {
      const mainHtmlPath = await MarkdownPreviewPanel.generateExternalPreview(extensionUri, docUri);
      await vscode.env.openExternal(vscode.Uri.file(mainHtmlPath));
    } catch (err) {
      vscode.window.showErrorMessage(`[md-index] openInBrowser error: ${err}`);
    }
  }

  private async openInBrowser(): Promise<void> {
    if (!this.documentUri) {
      vscode.window.showErrorMessage('[md-index] openInBrowser: documentUri is not set');
      return;
    }
    await MarkdownPreviewPanel.openInBrowser(this.extensionUri, this.documentUri);
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
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 1.00195C6.61553 1.00195 5.26216 1.4125 4.11101 2.18167C2.95987 2.95084 2.06266 4.04409 1.53285 5.32317C1.00303 6.60225 0.864412 8.00972 1.13451 9.36759C1.4046 10.7255 2.07129 11.9727 3.05026 12.9517C4.02922 13.9307 5.27651 14.5974 6.63437 14.8675C7.99224 15.1375 9.3997 14.9989 10.6788 14.4691C11.9579 13.9393 13.0511 13.0421 13.8203 11.8909C14.5895 10.7398 15 9.38642 15 8.00195C15 6.14544 14.2625 4.36496 12.9498 3.05221C11.637 1.73945 9.85652 1.00195 8 1.00195ZM8 14.002V2.00195C9.5913 2.00195 11.1174 2.63409 12.2426 3.75931C13.3679 4.88453 14 6.41065 14 8.00195C14 9.59325 13.3679 11.1194 12.2426 12.2446C11.1174 13.3698 9.5913 14.002 8 14.002Z"></path>
      </svg>
    </button>
    <button id="mi-open-browser" title="View on External Browser">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 1C4.141 1 1 4.141 1 8C1 11.859 4.141 15 8 15C11.859 15 15 11.859 15 8C15 4.141 11.859 1 8 1ZM8 14C7.422 14 6.686 12.906 6.288 11H9.713C9.315 12.906 8.579 14 8.001 14H8ZM6.121 10C6.044 9.392 6 8.723 6 8C6 7.277 6.044 6.608 6.121 6H9.878C9.955 6.608 9.999 7.277 9.999 8C9.999 8.723 9.955 9.392 9.878 10H6.121ZM2 8C2 7.299 2.121 6.626 2.343 6H5.121C5.041 6.656 5 7.332 5 8C5 8.668 5.041 9.344 5.121 10H2.343C2.121 9.374 2 8.701 2 8ZM8 2C8.578 2 9.314 3.094 9.712 5H6.287C6.685 3.094 7.422 2 8 2ZM10.879 6H13.657C13.879 6.626 14 7.299 14 8C14 8.701 13.879 9.374 13.657 10H10.879C10.959 9.344 11 8.668 11 8C11 7.332 10.959 6.656 10.879 6ZM13.195 5H10.722C10.516 3.938 10.199 2.98 9.775 2.268C11.228 2.719 12.446 3.707 13.195 5ZM6.226 2.268C5.802 2.98 5.484 3.938 5.279 5H2.806C3.556 3.707 4.774 2.718 6.226 2.268ZM2.805 11H5.278C5.484 12.062 5.801 13.02 6.225 13.732C4.772 13.281 3.554 12.293 2.805 11ZM9.774 13.732C10.198 13.02 10.516 12.062 10.721 11H13.194C12.444 12.293 11.226 13.282 9.774 13.732Z"></path>
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

      renderMermaid(content.getAttribute('data-theme'));

      document.getElementById('mi-theme-toggle').addEventListener('click', () => {
        const next = content.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        // Reset to the un-rendered markup before re-running mermaid, otherwise
        // it has no diagram source left to re-parse (it already became SVG).
        content.innerHTML = currentRawHtml;
        content.setAttribute('data-theme', next);
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
