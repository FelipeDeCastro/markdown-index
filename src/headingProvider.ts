import * as vscode from 'vscode';
import { HeadingNode, buildTree, parseHeadings } from './headingParser';

export class HeadingTreeProvider implements vscode.TreeDataProvider<HeadingNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<HeadingNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private roots: HeadingNode[] = [];
  private filteredRoots: HeadingNode[] | undefined;
  private _documentUri: vscode.Uri | undefined;
  private _filterTerm: string | undefined;
  private _expandState: 'initial' | 'collapsed' | 'expanded' = 'initial';
  private _generation = 0;

  /** The URI of the markdown document currently shown in the tree. */
  get documentUri(): vscode.Uri | undefined {
    return this._documentUri;
  }

  get filterTerm(): string | undefined {
    return this._filterTerm;
  }

  get expandState(): 'initial' | 'collapsed' | 'expanded' {
    return this._expandState;
  }

  collapseAll(): void {
    this._expandState = 'collapsed';
    this._generation++;
    this._onDidChangeTreeData.fire();
  }

  expandAll(): void {
    this._expandState = 'expanded';
    this._generation++;
    this._onDidChangeTreeData.fire();
  }

  setFilter(term: string | undefined): void {
    this._filterTerm = term;
    this.filteredRoots = term ? this.filterTree(this.roots, term.toLowerCase()) : undefined;
    this._onDidChangeTreeData.fire();
  }

  refresh(document: vscode.TextDocument | undefined): void {
    if (document && document.languageId === 'markdown') {
      this._documentUri = document.uri;
      const headings = parseHeadings(document.getText());
      this.roots = buildTree(headings);
      this.filteredRoots = this._filterTerm
        ? this.filterTree(this.roots, this._filterTerm.toLowerCase())
        : undefined;
      this._expandState = 'initial';
      this._onDidChangeTreeData.fire();
    } else if (document) {
      // Switched to a non-markdown editor — clear the tree.
      this._documentUri = undefined;
      this.roots = [];
      this.filteredRoots = undefined;
      this._onDidChangeTreeData.fire();
    }
    // If document is undefined (e.g. preview focused), keep current headings.
  }

  clear(): void {
    this._documentUri = undefined;
    this._filterTerm = undefined;
    this._expandState = 'initial';
    this.roots = [];
    this.filteredRoots = undefined;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node: HeadingNode): vscode.TreeItem {
    const hasChildren = node.children.length > 0;

    const term = this._filterTerm?.toLowerCase();
    let label: string | vscode.TreeItemLabel = node.text;
    if (term) {
      const idx = node.text.toLowerCase().indexOf(term);
      if (idx >= 0) {
        label = { label: node.text, highlights: [[idx, idx + term.length]] };
      }
    }

    let collapsibleState = vscode.TreeItemCollapsibleState.None;
    if (hasChildren) {
      if (this._expandState === 'expanded') {
        collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
      } else if (this._expandState === 'collapsed') {
        collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
      } else {
        const activeRoots = this.filteredRoots ?? this.roots;
        collapsibleState = activeRoots.includes(node)
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed;
      }
    }

    const item = new vscode.TreeItem(label, collapsibleState);
    item.id = `${this._generation}:${node.line}:${node.level}`;
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
      return this.filteredRoots ?? this.roots;
    }
    return node.children;
  }

  getParent(node: HeadingNode): HeadingNode | undefined {
    const activeRoots = this.filteredRoots ?? this.roots;
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
    return find(activeRoots, node);
  }

  private filterTree(nodes: HeadingNode[], term: string): HeadingNode[] {
    const result: HeadingNode[] = [];
    for (const node of nodes) {
      const selfMatch = node.text.toLowerCase().includes(term);
      const filteredChildren = this.filterTree(node.children, term);
      if (selfMatch || filteredChildren.length > 0) {
        result.push({
          ...node,
          children: selfMatch ? node.children : filteredChildren,
        });
      }
    }
    return result;
  }
}
