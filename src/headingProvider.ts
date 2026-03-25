import * as vscode from 'vscode';
import { HeadingNode, buildTree, parseHeadings } from './headingParser';

export class HeadingTreeProvider implements vscode.TreeDataProvider<HeadingNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<HeadingNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private roots: HeadingNode[] = [];
  private hasDocument = false;

  refresh(document: vscode.TextDocument | undefined): void {
    if (document && document.languageId === 'markdown') {
      this.hasDocument = true;
      const headings = parseHeadings(document.getText());
      this.roots = buildTree(headings);
    } else {
      this.hasDocument = false;
      this.roots = [];
    }
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
    item.iconPath = new vscode.ThemeIcon('symbol-structure');
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
