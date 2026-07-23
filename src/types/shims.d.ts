// Ambient module declarations for third-party packages that ship no type
// definitions (and have no @types/* package available on npm). Each is
// loosely typed as `any`-shaped; call sites are still verified manually
// against each package's actual runtime API (see previewPanel.ts comments).

declare module 'highlight.js/lib/common' {
  import hljs from 'highlight.js';
  export default hljs;
}

declare module 'markdown-it-task-lists' {
  import MarkdownIt = require('markdown-it');
  interface TaskListsOptions {
    enabled?: boolean;
    label?: boolean;
    labelAfter?: boolean;
  }
  function taskLists(md: MarkdownIt, options?: TaskListsOptions): void;
  export = taskLists;
}

declare module 'markdown-it-footnote' {
  import MarkdownIt = require('markdown-it');
  function footnote(md: MarkdownIt): void;
  export = footnote;
}
