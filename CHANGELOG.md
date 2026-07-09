# Changelog

## 0.7.2 — 2026-07-09

- Preview panel content now stretches full width, matching VS Code's built-in Markdown preview, instead of being capped and centered at 900px. (Printed output keeps the 900px width cap for readability.)

## 0.7.1 — 2026-07-09

- Fix: the extension failed to activate entirely after updating to 0.7.0 (no commands registered, "no data provider registered" in the sidebar). Caused by `.vscodeignore` excluding `node_modules/`, which stripped the `markdown-it` runtime dependency from the packaged VSIX. `markdown-it` is now bundled correctly; `github-markdown-css` (build-time only, vendored as a static CSS file) moved to `devDependencies`.

## 0.7.0 — 2026-07-09

- Fix: the Markdown Index Explorer section now starts collapsed by default (was always expanded, even with no markdown file open).
- New custom markdown preview panel (GitHub-styled via `github-markdown-css`) replacing the built-in preview:
  - Print the current file with the preview layout applied.
  - Toggle the preview between light and dark theme (icon toggle), independent of or matching the active VS Code color theme; default behavior configurable via `markdownIndex.previewTheme`.
  - Double-click a line in the preview to jump to the equivalent line in the markdown source editor.
  - Preview opens in the same editor group/column as the source file instead of always opening beside it.

## 0.6.4 — 2026-04-02

- Fix: show headings for `SKILL.md`, `.prompt.md`, `.instructions.md`, and `.agent.md` files (VS Code assigns them non-markdown language IDs via the built-in `prompt-basics` extension).

## 0.6.3 — 2026-04-02

- Remove SKILL.md from the packaged extension.

## 0.6.2 — 2026-04-02

- Fix: skip YAML frontmatter when parsing headings so front-matter content is not shown in the index.

## 0.6.1 — 2026-03-26

- Scroll to heading at the top of the editor window instead of centering it.

## 0.1.0 — 2026-03-25

- Initial release.
- Hierarchical heading outline (H1–H6) in the Explorer panel.
- Click-to-navigate to headings.
- Live refresh on document edits.
