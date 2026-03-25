import * as vscode from 'vscode';
import { HeadingNode, buildTree, parseHeadings } from './headingParser';

export class HeadingTreeProvider implements vscode.TreeDataProvider<HeadingNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<HeadingNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private roots: HeadingNode[] = [];
  private _documentUri: vscode.Uri | undefined;

  /** The URI of the markdown document currently shown in the tree. */
  get documentUri(): vscode.Uri | undefined {
    return this._documentUri;
  }

  refresh(document: vscode.TextDocument | undefined): void {
    if (document && document.languageId === 'markdown') {
      this._documentUri = document.uri;
      const headings = parseHeadings(document.getText());
      this.roots = buildTree(headings);
      this._onDidChangeTreeData.fire();
    } else if (document) {
      // Switched to a non-markdown editor — clear the tree.
      this._documentUri = undefined;
      this.roots = [];
      this._onDidChangeTreeData.fire();
    }
    // If document is undefined (e.g. preview focused), keep current headings.
  }

  clear(): void {
    this._documentUri = undefined;
    this.roots = [];
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node: HeadingNode): vscode.TreeItem {
    const hasChildren = node.children.length > 0;
    const item = new vscode.TreeItem(
      node.text,
      hasChildren
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );
    item.description = `H${node.level}`;
    item.tooltip = `${node.text} — line ${node.line + 1}`;
    item.contextValue = 'heading';
    item.command = {
      command: 'markdownIndex.revealHeading',
      title: 'Go to Heading',
      arguments: [node],
    };
    return item;
  }

  getChildren(node?: HeadingNode): HeadingNode[] {
    if (!node) {
      return this.roots;
    }
    return node.children;
  }

  getParent(node: HeadingNode): HeadingNode | undefined {
    // Walk the tree to find parent — needed for reveal API.
    const find = (
      roots: HeadingNode[],
      target: HeadingNode,
    ): HeadingNode | undefined => {
      for (const root of roots) {
        if (root.children.includes(target)) {
          return root;
        }
        const found = find(root.children, target);
        if (found) {
          return found;
        }
      }
      return undefined;
    };
    return find(this.roots, node);
  }
}
