# JS/TS Import Order

Groups and sorts the import block of JavaScript and TypeScript files.

```ts
// built-ins
import child_process from "child_process";
import fs from "node:fs";
import path from "node:path";

// external
import React from "react"; // priority
import Typography from "@mui/material/Typography";
import Bootstrap from "bootstrap";

// internal
import auth from "@packages/auth";
import contact from "@packages/contact";

// relative, grouped by distance
import Button from "../../../Button";
import Card from "../../../Card";

import copy from "../../lib";

import { TextType } from ".";
```

Group order:

1. **Built-ins**: `node:*` and bare Node modules (`fs`, `path`, `child_process`,
   …). `fs` and `node:fs` sort as the same module.
2. **External**: everything not matched below.
3. **Internal**: packages and aliases you list in `package.json`.
4. **Relative**, one group per distance from the current file: furthest
   (`../../../x`) at the top, closest (`./x`, `.`) at the bottom.

## Configuration

Add a `jsTsImports` key to `package.json`. The nearest `package.json` that has
the key wins, so a monorepo root can configure every package. **All options are
optional**.

```json
{
  "jsTsImports": {
    "internal": ["@packages/*", "@/*"],
    "priority": ["react"],
    "external": ["@packages/ui-kit"],
    "builtins": ["fs", "path", "child_process", "bun:*"]
  }
}
```

| Option     | Meaning                                                                        | Default                 |
| ---------- | ------------------------------------------------------------------------------ | ----------------------- |
| `internal` | Project/workspace packages and aliases.                                        | `["#*", "@/*", "~/*"]`  |
| `external` | Forced to external. Wins over `internal` (carve-outs like `@packages/ui-kit`). | `[]`                    |
| `priority` | Sorted first inside whichever package group they land in, in the order given.  | `[]`                    |
| `builtins` | Replaces the built-in module list. `node:*` is always built-in.                | Node's `builtinModules` |

Patterns: `*` is a wildcard. A pattern without `*` matches the package and its
subpaths, so `react` matches `react` and `react/jsx-runtime` but not
`react-dom`. Unknown option names and wrong types raise an error instead of
being ignored.

## Install and use

Install the `.vsix`: `codium --install-extension js-ts-import-order-0.1.0.vsix`.

- Command palette: **Sort Imports (JS/TS)**
- Source action on save, which runs before the formatter:

```json
{
  "editor.codeActionsOnSave": { "source.jsTsImports": "explicit" }
}
```

The save action runs before the formatter, so it works alongside Prettier (or
any formatter): imports are sorted first, then the formatter prints the file.
Sorting is idempotent, so saving twice changes nothing. The extension uses its
own source-action kind rather than `source.organizeImports`, so it won't fight
TypeScript's built-in organize-imports.

It applies to JavaScript, JavaScript React, TypeScript and TypeScript React
files. Problems such as an invalid `jsTsImports` config are written to the
**JS/TS Imports** output channel.

## Behaviour notes

- Only the first uninterrupted block of `import` statements is handled. A
  non-import statement ends it.
- **Side-effect imports** (`import "reflect-metadata"`, `import "./styles.css"`)
  stay where they are. Imports above and below are sorted independently, each
  run separated by a blank line.
- Comments directly above an import, and trailing comments on its line, travel
  with it. A comment block at the very top of the file (license,
  `// @ts-nocheck`) stays on top. A comment separated from the imports by blank
  lines attaches to the import below it.
- Sorting is case-insensitive and locale independent, so every machine produces
  the same order.
- Files that don't parse, or put several statements on one line, are returned
  unchanged.
- Reordering imports changes module evaluation order. That matters only for
  modules with import-time side effects imported by name (for example CSS
  modules); use a bare side-effect import to pin the order.

## Development

```sh
npm install
npm test            # build + unit tests
npm run typecheck
npm run package     # builds vscode-extension/js-ts-imports-<version>.vsix
```

Layout: `core/` (parsing, grouping, config) and `vscode-extension/` (thin editor
integration). The extension is bundled with esbuild; `@babel/parser` is bundled
in, so it has no runtime dependencies.
