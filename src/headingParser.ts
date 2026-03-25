export interface Heading {
  level: number;
  text: string;
  line: number;
}

export interface HeadingNode extends Heading {
  children: HeadingNode[];
}

const HEADING_RE = /^(#{1,6})\s+(.+?)(?:\s+#+\s*)?$/;
const FENCE_RE = /^(`{3,}|~{3,})/;

/**
 * Extract flat headings from markdown text, skipping fenced code blocks.
 */
export function parseHeadings(text: string): Heading[] {
  const headings: Heading[] = [];
  const lines = text.split('\n');
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;

  for (let i = 0; i < lines.length; i++) {
    const fenceMatch = lines[i].match(FENCE_RE);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceChar = fenceMatch[1][0];
        fenceLen = fenceMatch[1].length;
      } else if (
        fenceMatch[1][0] === fenceChar &&
        fenceMatch[1].length >= fenceLen
      ) {
        inFence = false;
      }
      continue;
    }
    if (inFence) {
      continue;
    }
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
