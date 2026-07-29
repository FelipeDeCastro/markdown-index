# Rich Markdown Example

> A comprehensive showcase of all standard Markdown elements, extended syntax, and Mermaid diagrams.

---

## Table of Contents

- [Headings](#headings)
- [Text Formatting](#text-formatting)
- [Blockquotes](#blockquotes)
- [Lists](#lists)
- [Code](#code)
- [Tables](#tables)
- [Links & Images](#links--images)
- [Horizontal Rules](#horizontal-rules)
- [Footnotes](#footnotes)
- [Task Lists](#task-lists)
- [Definition Lists](#definition-lists)
- [Math Equations](#math-equations)
- [Collapsible Sections](#collapsible-sections)
- [Mermaid Diagrams](#mermaid-diagrams)

---

## Headings

# Heading Level 1
## Heading Level 2
### Heading Level 3
#### Heading Level 4
##### Heading Level 5
###### Heading Level 6

---

## Text Formatting

Regular paragraph text. Lorem ipsum dolor sit amet, consectetur adipiscing elit.
Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.

**Bold text** and __also bold__.

*Italic text* and _also italic_.

***Bold and italic*** and ___also bold and italic___.

~~Strikethrough text~~

`Inline code`

<kbd>Ctrl</kbd> + <kbd>C</kbd>

<mark>Highlighted text</mark>

Superscript: X<sup>2</sup> + Y<sup>2</sup> = Z<sup>2</sup>

Subscript: H<sub>2</sub>O

---

## Blockquotes

> Single-level blockquote.

> Multi-line blockquote.
> This continues on the next line.

> Nested blockquote.
>
> > This is a nested quote inside the outer one.
> >
> > > And another level deeper.

> **Note:** Blockquotes can contain **formatting**, `code`, and other elements.

---

## Lists

### Unordered List

- Item one
- Item two
  - Nested item A
  - Nested item B
    - Deeply nested item
- Item three

### Ordered List

1. First item
2. Second item
   1. Sub-item 2.1
   2. Sub-item 2.2
3. Third item
4. Fourth item

### Mixed Nesting

1. Ordered first
   - Unordered nested under ordered
   - Another unordered item
2. Ordered second
   1. Ordered nested
      - Mixed level three

---

## Code

### Inline Code

Use `git commit -m "message"` to commit staged changes.

Call `console.log()` to print to the developer console.

### Fenced Code Blocks

```bash
# Shell script example
#!/usr/bin/env bash
set -euo pipefail

NAME="World"
echo "Hello, ${NAME}!"

for i in {1..5}; do
  echo "Iteration: $i"
done
```

```typescript
// TypeScript example
interface User {
  id: number;
  name: string;
  email: string;
  createdAt: Date;
}

async function fetchUser(id: number): Promise<User | null> {
  try {
    const response = await fetch(`/api/users/${id}`);
    if (!response.ok) return null;
    return response.json() as Promise<User>;
  } catch (error) {
    console.error("Failed to fetch user:", error);
    return null;
  }
}
```

```python
# Python example
from dataclasses import dataclass
from typing import Optional

@dataclass
class Node:
    value: int
    left: Optional["Node"] = None
    right: Optional["Node"] = None

def inorder(node: Optional[Node]) -> list[int]:
    if node is None:
        return []
    return inorder(node.left) + [node.value] + inorder(node.right)

root = Node(4, Node(2, Node(1), Node(3)), Node(6, Node(5), Node(7)))
print(inorder(root))  # [1, 2, 3, 4, 5, 6, 7]
```

```json
{
  "name": "markdown-example",
  "version": "1.0.0",
  "description": "A rich markdown showcase",
  "scripts": {
    "build": "tsc",
    "test": "jest"
  },
  "dependencies": {
    "remark": "^15.0.0"
  }
}
```

```sql
-- SQL example
SELECT
  u.id,
  u.name,
  COUNT(o.id)  AS order_count,
  SUM(o.total) AS total_spent
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
WHERE u.created_at >= DATE_SUB(NOW(), INTERVAL 1 YEAR)
GROUP BY u.id, u.name
HAVING total_spent > 100
ORDER BY total_spent DESC
LIMIT 10;
```

---

## Tables

### Basic Table

| Name    | Type    | Required | Description                       |
| ------- | ------- | :------: | --------------------------------- |
| `id`    | number  |    ✓     | Unique identifier                 |
| `name`  | string  |    ✓     | Human-readable label              |
| `tags`  | array   |          | Optional list of category strings |
| `score` | float   |          | Relevance score between 0 and 1   |
| `meta`  | object  |          | Arbitrary key-value metadata      |

### Alignment Demo

| Left-aligned | Center-aligned | Right-aligned |
| :----------- | :------------: | ------------: |
| Alpha        |     Delta      |           700 |
| Beta         |    Epsilon     |         1 200 |
| Gamma        |      Zeta      |        98 765 |

---

## Links & Images

### Links

[External link](https://github.com)

[Link with title](https://github.com "Visit GitHub")

[Reference-style link][ref-label]

[ref-label]: https://example.com "Example Domain"

Auto-linked URL: <https://www.example.com>

Email link: <user@example.com>

### Images

![Alt text placeholder](https://placehold.co/600x200/0d1117/58a6ff?text=Markdown+Preview "Image title")

#### Image as a Link

[![Linked image](https://placehold.co/200x60/238636/ffffff?text=Click+Me)](https://github.com)

---

## Horizontal Rules

Three ways to draw a horizontal rule:

---

***

___

---

## Footnotes

Here is a sentence with a footnote.[^1]

Extended footnotes support multi-paragraph notes.[^long-note]

[^1]: This is the first footnote definition.

[^long-note]: This footnote spans multiple paragraphs.

    Indent paragraphs to include them in the footnote body.

    You can include **formatting** and `code` inside footnotes.

---

## Task Lists

### Project Checklist

- [x] Set up repository
- [x] Write initial README
- [x] Add CI/CD pipeline
- [ ] Write unit tests
- [ ] Publish first release
- [ ] Set up documentation site

### Nested Tasks

- [x] Backend
  - [x] REST API endpoints
  - [x] Database schema
  - [ ] Rate limiting
- [ ] Frontend
  - [x] Login page
  - [ ] Dashboard view
  - [ ] Settings page

---

## Definition Lists

<dl>
  <dt>Markdown</dt>
  <dd>A lightweight markup language for creating formatted text using a plain-text editor.</dd>

  <dt>CommonMark</dt>
  <dd>A strongly specified, highly compatible implementation of Markdown.</dd>

  <dt>GFM</dt>
  <dd>GitHub Flavored Markdown — a superset of CommonMark with extensions like tables and task lists.</dd>
</dl>

---

## Math Equations

### Inline Math

The quadratic formula is $x = \dfrac{-b \pm \sqrt{b^2 - 4ac}}{2a}$.

Euler's identity: $e^{i\pi} + 1 = 0$

### Block Math

$$
\int_{-\infty}^{\infty} e^{-x^2}\, dx = \sqrt{\pi}
$$

$$
\nabla \times \mathbf{B} - \frac{1}{c}\frac{\partial \mathbf{E}}{\partial t} = \frac{4\pi}{c}\mathbf{J}
$$

$$
\sum_{n=1}^{\infty} \frac{1}{n^2} = \frac{\pi^2}{6}
$$

---

## Collapsible Sections

<details>
<summary>Click to expand — Installation Instructions</summary>

### Prerequisites

- Node.js >= 18
- npm >= 9

### Steps

```bash
git clone https://github.com/example/project.git
cd project
npm install
npm run build
```

You can nest **any** Markdown inside a `<details>` block, including code, tables, and lists.

</details>

<details>
<summary>Advanced Configuration</summary>

| Option       | Default | Description                         |
| ------------ | ------- | ----------------------------------- |
| `port`       | `3000`  | HTTP server port                    |
| `logLevel`   | `info`  | One of `debug`, `info`, `warn`, `error` |
| `maxRetries` | `3`     | Maximum number of retry attempts    |

</details>

---

## Mermaid Diagrams

### Flowchart

```mermaid
flowchart TD
    A([Start]) --> B{Is data valid?}
    B -- Yes --> C[Process data]
    B -- No --> D[Return validation error]
    C --> E{Save to database}
    E -- Success --> F[Send confirmation email]
    E -- Failure --> G[Log error]
    F --> H([End])
    G --> H
    D --> H
```

### Sequence Diagram

```mermaid
sequenceDiagram
    actor User
    participant Browser
    participant API
    participant DB

    User->>Browser: Submit login form
    Browser->>API: POST /auth/login
    API->>DB: SELECT user WHERE email = ?
    DB-->>API: User record
    API->>API: Verify password hash
    alt Valid credentials
        API-->>Browser: 200 OK + JWT token
        Browser-->>User: Redirect to dashboard
    else Invalid credentials
        API-->>Browser: 401 Unauthorized
        Browser-->>User: Show error message
    end
```

### Class Diagram

```mermaid
classDiagram
    class Animal {
        +String name
        +int age
        +makeSound() void
        +eat(food: String) void
    }

    class Dog {
        +String breed
        +fetch() void
        +makeSound() void
    }

    class Cat {
        +bool isIndoor
        +purr() void
        +makeSound() void
    }

    class Owner {
        +String name
        +List~Animal~ pets
        +adopt(animal: Animal) void
    }

    Animal <|-- Dog
    Animal <|-- Cat
    Owner "1" --> "*" Animal : owns
```

### Entity Relationship Diagram

```mermaid
erDiagram
    USER {
        int id PK
        string name
        string email UK
        datetime created_at
    }
    POST {
        int id PK
        string title
        text body
        datetime published_at
        int author_id FK
    }
    TAG {
        int id PK
        string slug UK
    }
    COMMENT {
        int id PK
        text body
        int post_id FK
        int user_id FK
    }

    USER ||--o{ POST : "writes"
    USER ||--o{ COMMENT : "leaves"
    POST ||--o{ COMMENT : "has"
    POST }o--o{ TAG : "tagged with"
```

### Gantt Chart

```mermaid
gantt
    title Project Timeline — Q3 2026
    dateFormat  YYYY-MM-DD
    excludes    weekends

    section Discovery
    Kickoff meeting          :done,    d1, 2026-07-01, 1d
    Requirements gathering   :done,    d2, 2026-07-02, 5d
    Technical spike          :active,  d3, 2026-07-09, 3d

    section Design
    UI wireframes            :         des1, after d3, 5d
    Design review            :crit,    des2, after des1, 2d

    section Development
    Backend API              :         dev1, after des2, 10d
    Frontend integration     :         dev2, after des2, 10d
    Unit tests               :crit,    dev3, after dev1, 5d

    section Release
    Staging deploy           :         rel1, after dev3, 1d
    QA sign-off              :crit,    rel2, after rel1, 3d
    Production release       :         rel3, after rel2, 1d
```

### State Diagram

```mermaid
stateDiagram-v2
    [*] --> Idle

    Idle --> Loading : fetch()
    Loading --> Success : resolve
    Loading --> Error : reject
    Error --> Loading : retry()
    Success --> Idle : reset()
    Error --> Idle : reset()

    Success --> [*] : done
```

### Pie Chart

```mermaid
pie title Browser Market Share (2026)
    "Chrome"  : 65.2
    "Safari"  : 19.4
    "Firefox" : 4.1
    "Edge"    : 4.9
    "Other"   : 6.4
```

### Git Graph

```mermaid
gitGraph
    commit id: "initial commit"
    commit id: "add CI"
    branch feature/auth
    checkout feature/auth
    commit id: "login endpoint"
    commit id: "JWT middleware"
    checkout main
    branch hotfix/typo
    checkout hotfix/typo
    commit id: "fix README typo"
    checkout main
    merge hotfix/typo id: "merge hotfix"
    checkout feature/auth
    commit id: "add tests"
    checkout main
    merge feature/auth id: "merge auth"
    commit id: "bump version"
```

### Quadrant Chart

```mermaid
quadrantChart
    title Technical Debt vs. Business Value
    x-axis Low Business Value --> High Business Value
    y-axis Low Technical Debt --> High Technical Debt
    quadrant-1 Tackle First
    quadrant-2 Reconsider
    quadrant-3 Low Priority
    quadrant-4 Quick Wins

    Authentication refactor: [0.75, 0.80]
    Dark mode toggle: [0.60, 0.20]
    Legacy API migration: [0.85, 0.90]
    Logging improvements: [0.30, 0.40]
    Search feature: [0.90, 0.35]
    Database indexing: [0.70, 0.60]
```

### Mind Map

```mermaid
mindmap
  root((Markdown))
    Headings
      H1 – H6
    Formatting
      Bold
      Italic
      Strikethrough
      Code
    Structure
      Lists
      Tables
      Blockquotes
    Media
      Links
      Images
    Extended
      Footnotes
      Task lists
      Math
      Mermaid
    Diagrams
      Flowchart
      Sequence
      Class
      ER
      Gantt
      State
      Pie
```

---

## HTML Embeds

Raw HTML can extend Markdown when needed.

<div align="center">

| Badge | Status |
|-------|--------|
| Build | <img src="https://img.shields.io/badge/build-passing-brightgreen" alt="build passing"> |
| License | <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"> |
| Version | <img src="https://img.shields.io/badge/version-1.0.0-orange" alt="version 1.0.0"> |

</div>

---

## Emoji

GitHub-flavored Markdown supports emoji shortcodes:

:rocket: Launch · :bug: Bug · :sparkles: Feature · :hammer: Fix · :books: Docs · :white_check_mark: Done · :warning: Warning · :fire: Hot · :lock: Security · :recycle: Refactor

---

*End of example — all standard and extended Markdown elements demonstrated above.*
