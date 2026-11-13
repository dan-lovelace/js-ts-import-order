import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { loadConfig, resolveConfig, sortImports } from "../core";

const cfg = resolveConfig({ internal: ["@packages/*"], priority: ["react"] });
const run = (src: string, c = cfg, file = "a.ts") => sortImports(src, c, file);

const EXPECTED = `import child_process from "child_process"; // built-in by default, overridable/editable in package.json
import fs from "node:fs";
import path from "node:path";

import react from "react"; // deemed external by package.json
import bootstrap from "bootstrap";

import auth from "@packages/auth"; // internal in package.json
import contact from "@packages/contact";

import Button from "../../../Button"; // local/relative
import Card from "../../../Card";

import copy from "../../lib";

import { TextType } from ".";
`;

test("reproduces the target layout from a shuffled file", () => {
  const shuffled = `import Card from "../../../Card";
import { TextType } from ".";
import react from "react"; // deemed external by package.json
import fs from "node:fs";
import contact from "@packages/contact";
import copy from "../../lib";
import child_process from "child_process"; // built-in by default, overridable/editable in package.json
import auth from "@packages/auth"; // internal in package.json
import path from "node:path";
import bootstrap from "bootstrap";
import Button from "../../../Button"; // local/relative
`;
  assert.equal(run(shuffled), EXPECTED);
});

test("is idempotent", () => {
  assert.equal(run(EXPECTED), EXPECTED);
});

test("without priority, externals are alphabetical", () => {
  const out = sortImports(
    `import react from "react";\nimport bootstrap from "bootstrap";\n`,
    resolveConfig({}),
    "a.ts",
  );
  assert.equal(
    out,
    `import bootstrap from "bootstrap";\nimport react from "react";\n`,
  );
});

test("built-ins ignore the node: prefix when sorting, and subpaths count", () => {
  const out = run(
    `import b from "path";\nimport a from "node:os";\nimport c from "fs/promises";\nimport d from "node:assert";\n`,
  );
  assert.equal(
    out,
    `import d from "node:assert";\nimport c from "fs/promises";\nimport a from "node:os";\nimport b from "path";\n`,
  );
});

test("builtins can be overridden", () => {
  const c = resolveConfig({ builtins: ["fs"] });
  const out = sortImports(
    `import p from "path";\nimport f from "fs";\n`,
    c,
    "a.ts",
  );
  assert.equal(out, `import f from "fs";\n\nimport p from "path";\n`);
});

test("relative imports group by distance, furthest first", () => {
  const out = run(
    `import a from "./a";\nimport b from "../b";\nimport c from "../../c";\nimport d from "..";\nimport e from "./x/y";\n`,
  );
  assert.equal(
    out,
    `import c from "../../c";\n\nimport d from "..";\nimport b from "../b";\n\nimport a from "./a";\nimport e from "./x/y";\n`,
  );
});

test("external patterns win over internal ones", () => {
  const c = resolveConfig({
    internal: ["@acme/*"],
    external: ["@acme/ui-kit"],
  });
  const out = sortImports(
    `import a from "@acme/core";\nimport k from "@acme/ui-kit";\n`,
    c,
    "a.ts",
  );
  assert.equal(
    out,
    `import k from "@acme/ui-kit";\n\nimport a from "@acme/core";\n`,
  );
});

test("side-effect imports sort alphabetically within their classification group", () => {
  const c = resolveConfig({
    internal: ["@acme/*"],
    priority: ["react"],
  });

  const out = sortImports(
    `import z from "z";
import "@acme/polyfill";
import "reflect-metadata";
import react from "react";
import a from "a";
import "@acme/core";
`,
    c,
    "a.ts",
  );

  assert.equal(
    out,
    `import react from "react";
import a from "a";
import "reflect-metadata";
import z from "z";

import "@acme/core";
import "@acme/polyfill";
`,
  );
});

test("file header stays, attached and trailing comments travel", () => {
  const out = run(
    `// @ts-nocheck\nimport z from "z"; // last\n// keep with a\nimport a from "a";\n\nconst x = 1;\n`,
  );
  assert.equal(
    out,
    `// @ts-nocheck\n// keep with a\nimport a from "a";\nimport z from "z"; // last\n\nconst x = 1;\n`,
  );
});

test("directives and multi-line imports are preserved", () => {
  const src = `"use client";\n\nimport {\n  b,\n  c,\n} from "b";\nimport a from "a";\n`;
  assert.equal(
    run(src),
    `"use client";\n\nimport a from "a";\nimport {\n  b,\n  c,\n} from "b";\n`,
  );
});

test("type imports and import attributes", () => {
  const out = run(
    `import type { T } from "./t";\nimport data from "./d.json" with { type: "json" };\nimport type { U } from "u";\n`,
  );
  assert.equal(
    out,
    `import type { U } from "u";\n\nimport data from "./d.json" with { type: "json" };\nimport type { T } from "./t";\n`,
  );
});

test("TSX and decorators parse", () => {
  const tsx = `import b from "b";\nimport a from "a";\nexport const X = () => <div />;\n`;
  assert.equal(
    sortImports(tsx, cfg, "x.tsx"),
    `import a from "a";\nimport b from "b";\n\nexport const X = () => <div />;\n`,
  );
  const deco = `import b from "b";\nimport a from "a";\n@Component()\nclass C {}\n`;
  assert.equal(
    sortImports(deco, cfg, "c.ts"),
    `import a from "a";\nimport b from "b";\n\n@Component()\nclass C {}\n`,
  );
});

test("only the leading import block is touched", () => {
  const src = `import b from "b";\nimport a from "a";\nconst x = 1;\nimport c from "c";\nimport aa from "aa";\n`;
  assert.equal(
    run(src),
    `import a from "a";\nimport b from "b";\n\nconst x = 1;\nimport c from "c";\nimport aa from "aa";\n`,
  );
});

test("CRLF line endings are kept", () => {
  const out = run(
    `import b from "b";\r\nimport "./x";\r\nimport a from "a";\r\n`,
  );
  assert.equal(
    out,
    `import a from "a";\r\nimport b from "b";\r\n\r\nimport "./x";\r\n`,
  );
});

test("unparsable files and shared-line statements are left alone", () => {
  const broken = `import b from "b";\nimport a from "a";\nconst = ;\n`;
  assert.equal(run(broken), broken);
  const oneLine = `import b from "b"; import a from "a";\n`;
  assert.equal(run(oneLine), oneLine);
});

test("config is read from the nearest package.json that has the key", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jsi-"));
  fs.mkdirSync(path.join(root, "packages", "app", "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ jsTsImports: { internal: ["@acme/*"] } }),
  );
  fs.writeFileSync(
    path.join(root, "packages", "app", "package.json"),
    JSON.stringify({ name: "app" }),
  );
  const c = loadConfig(path.join(root, "packages", "app", "src", "index.ts"));
  assert.deepEqual(c.internal, ["@acme/*"]);
});

test("bad config fails loudly", () => {
  assert.throws(() => resolveConfig({ internals: [] }), /unknown option/);
  assert.throws(() => resolveConfig({ internal: "x" }), /array of strings/);
});

test("a blank line always separates the last import from what follows", () => {
  const src = `import { browser } from "../browser";
import {
  BrowserStorage,
  BrowserStorageKey,
  BrowserStorageValue,
  
} from "../storage/versions/schema-base";
  export type WebExtensionBrowser = typeof browser;
`;
  const expected = `import { browser } from "../browser";
import {
  BrowserStorage,
  BrowserStorageKey,
  BrowserStorageValue,
  
} from "../storage/versions/schema-base";

export type WebExtensionBrowser = typeof browser;
`;
  assert.equal(run(src), expected);
  assert.equal(run(expected), expected);
});

test("separation works for const, comments, CRLF, and leaves existing gaps and EOF alone", () => {
  assert.equal(
    run(`import a from "a";\nconst x = 1;\n`),
    `import a from "a";\n\nconst x = 1;\n`,
  );
  assert.equal(
    run(`import a from "a"; // t\n// about x\nconst x = 1;\n`),
    `import a from "a"; // t\n\n// about x\nconst x = 1;\n`,
  );
  assert.equal(
    run(`import a from "a";\r\nconst x = 1;\r\n`),
    `import a from "a";\r\n\r\nconst x = 1;\r\n`,
  );
  const spaced = `import a from "a";\n\n\nconst x = 1;\n`;
  assert.equal(run(spaced), spaced);
  assert.equal(run(`import a from "a";\n`), `import a from "a";\n`);
  assert.equal(run(`import a from "a";`), `import a from "a";`);
});
