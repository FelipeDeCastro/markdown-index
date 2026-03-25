export interface Heading {
  level: number;
  text: string;
  line: number;
}

export interface HeadingNode extends Heading {
  children: HeadingNode[];
}

const HEADING_RE = /^(#{1,6})\s+(.+?)(?:\s+#+\s*)?$/;

/**
 * Extract flat headings from markdown text.
 */
export function parseHeadings(text: string): Heading[] {
  const headings: Heading[] = [];
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(HEADING_RE);
    if (match) {
      headings.push({
        level: match[1].length,
        text: match[2].trim(),
        line: i,
      });
    }
  }

  return headings;
}

/**
 * Build a tree from a flat list of headings.
 * Lower-level headings become children of the nearest higher-level heading above them.
 */
export function buildTree(headings: Heading[]): HeadingNode[] {
  const roots: HeadingNode[] = [];
  const stack: HeadingNode[] = [];

  for (const h of headings) {
    const node: HeadingNode = { ...h, children: [] };

    // Walk up the stack until we find a parent with a smaller level number.
    while (stack.length > 0 && stack[stack.length - 1].level >= node.level) {
      stack.pop();
    }

    if (stack.length > 0) {
      stack[stack.length - 1].children.push(node);
    } else {
      roots.push(node);
    }

    stack.push(node);
  }

  return roots;
}
