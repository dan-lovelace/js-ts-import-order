import * as path from "node:path";

import { parse, type ParserPlugin } from "@babel/parser";
import type { ImportDeclaration } from "@babel/types";

import { DEFAULT_CONFIG, type ImportOrderConfig } from "./config";

interface Span {
  start: number;
  end: number;
  startLine: number;
  endLine: number;
}

/** One import statement plus the comments that travel with it. */
interface Item {
  text: string;
  spec: string;
  sideEffect: boolean;
  start: number;
  end: number;
}

interface Matchers {
  builtins: RegExp[];
  external: RegExp[];
  internal: RegExp[];
  priority: RegExp[];
}

// ---------------------------------------------------------------------------
// Pattern matching and classification
// ---------------------------------------------------------------------------

const escapeRegExp = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/** `*` is a wildcard; a trailing `/subpath` is always allowed. */
export function compilePattern(pattern: string): RegExp {
  return new RegExp(
    `^${pattern.split("*").map(escapeRegExp).join(".*")}(?:/.*)?$`,
  );
}

function compileConfig(config: ImportOrderConfig): Matchers {
  return {
    builtins: config.builtins.map(compilePattern),
    external: config.external.map(compilePattern),
    internal: config.internal.map(compilePattern),
    priority: config.priority.map(compilePattern),
  };
}

const matchesAny = (list: RegExp[], spec: string) =>
  list.some((re) => re.test(spec));

const isRelative = (spec: string) =>
  spec === "." ||
  spec === ".." ||
  spec.startsWith("./") ||
  spec.startsWith("../");

/** Number of leading `..` segments: "../../x" -> 2, "./x" -> 0. */
function relativeDepth(spec: string): number {
  let depth = 0;
  for (const part of spec.split("/")) {
    if (part === ".") continue;
    if (part === "..") depth++;
    else break;
  }
  return depth;
}

const MAX_DEPTH = 10_000;

/**
 * rank 0 = built-in, 1 = external, 2 = internal, 3+ = relative
 * (further up the tree gets a lower rank, so it sorts earlier).
 */
function classify(spec: string, m: Matchers) {
  if (isRelative(spec)) {
    return {
      rank: 3 + (MAX_DEPTH - Math.min(relativeDepth(spec), MAX_DEPTH)),
      priority: m.priority.length,
      sortKey: spec,
    };
  }
  const builtin = spec.startsWith("node:") || matchesAny(m.builtins, spec);
  const rank = builtin
    ? 0
    : matchesAny(m.external, spec)
      ? 1
      : matchesAny(m.internal, spec)
        ? 2
        : 1;
  let priority = m.priority.findIndex((re) => re.test(spec));
  if (priority === -1) priority = m.priority.length;
  // `fs` and `node:fs` sort as the same module.
  return {
    rank,
    priority,
    sortKey: builtin ? spec.replace(/^node:/, "") : spec,
  };
}

/** Deterministic (locale independent) case-insensitive comparison. */
function compareText(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x !== y) return x < y ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function renderGroups(items: Item[], m: Matchers, eol: string): string {
  const ranked = items.map((item) => ({ item, ...classify(item.spec, m) }));
  ranked.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.priority - b.priority ||
      compareText(a.sortKey, b.sortKey),
  );
  const lines: string[] = [];
  let lastRank = -1;
  for (const r of ranked) {
    if (lastRank !== -1 && r.rank !== lastRank) lines.push(""); // blank line between groups
    lines.push(r.item.text);
    lastRank = r.rank;
  }
  return lines.join(eol);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parserAttempts(fileName?: string): ParserPlugin[][] {
  const ext = fileName ? path.extname(fileName).toLowerCase() : "";
  let sets: ParserPlugin[][];
  if (ext === ".ts" || ext === ".mts" || ext === ".cts")
    sets = [["typescript"], ["typescript", "jsx"]];
  else if (ext === ".tsx") sets = [["typescript", "jsx"]];
  else if ([".js", ".jsx", ".mjs", ".cjs"].includes(ext))
    sets = [["jsx"], ["jsx", "flow"]];
  else sets = [["typescript", "jsx"], ["typescript"], ["jsx", "flow"]];
  return sets.map((s) => [...s, "decorators-legacy"]);
}

function tryParse(code: string, fileName?: string) {
  for (const plugins of parserAttempts(fileName)) {
    try {
      return parse(code, {
        sourceType: "unambiguous",
        plugins,
        attachComment: false,
        allowReturnOutsideFunction: true,
      });
    } catch {
      // try the next syntax combination
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Source helpers
// ---------------------------------------------------------------------------

const lineStart = (code: string, offset: number) =>
  offset === 0 ? 0 : code.lastIndexOf("\n", offset - 1) + 1;

const onlyWhitespaceBefore = (code: string, offset: number) =>
  code.slice(lineStart(code, offset), offset).trim() === "";

/** True when everything before `offset` is a BOM, a shebang, or whitespace. */
const isFileHeader = (code: string, offset: number) =>
  code
    .slice(0, offset)
    .replace(/^\uFEFF/, "")
    .replace(/^#![^\n]*/, "")
    .trim() === "";

/**
 * Start of the contiguous run of own-line comments directly above `node`
 * (no blank line in between).
 */
function attachedCommentStart(
  code: string,
  comments: Span[],
  node: ImportDeclaration,
): number {
  let start = node.start!;
  let line = node.loc!.start.line;
  for (;;) {
    const above = comments.filter(
      (c) => c.endLine === line - 1 && c.end <= start,
    );
    if (above.length === 0) break;
    const first = above[0];
    if (!onlyWhitespaceBefore(code, first.start)) break; // trailing comment of the previous statement
    start = first.start;
    line = first.startLine;
  }
  return start;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Sorts and groups the leading block of import statements.
 *
 * Returns the input unchanged when the file can't be parsed, has no leading
 * imports, or has a layout this tool won't touch (several statements on one line).
 *
 * Rules
 *  - Only the first uninterrupted run of `import` statements is handled.
 *  - Side-effect imports (`import "x"`) act as barriers: they stay in place and
 *    the imports on either side are sorted independently.
 *  - Comments directly above an import and same-line trailing comments move
 *    with it. A comment block at the very top of the file stays put.
 */
export function sortImports(
  code: string,
  config: ImportOrderConfig = DEFAULT_CONFIG,
  fileName?: string,
): string {
  const ast = tryParse(code, fileName);
  if (!ast) return code;

  const imports: ImportDeclaration[] = [];
  for (const stmt of ast.program.body) {
    if (stmt.type !== "ImportDeclaration") break;
    imports.push(stmt);
  }
  if (imports.length === 0) return code;

  const comments: Span[] = (ast.comments ?? []).map((c) => ({
    start: c.start!,
    end: c.end!,
    startLine: c.loc!.start.line,
    endLine: c.loc!.end.line,
  }));

  const items: Item[] = [];
  let prevEnd = 0;
  for (let i = 0; i < imports.length; i++) {
    const node = imports[i];
    const nodeStart = node.start!;
    const nodeEnd = node.end!;

    // Where this item's text begins (leading comments included).
    let start = nodeStart;
    if (i === 0) {
      start = attachedCommentStart(code, comments, node);
      if (start < nodeStart && isFileHeader(code, start)) start = nodeStart; // file header stays on top
    } else {
      const gap = comments.find(
        (c) => c.start >= prevEnd && c.end <= nodeStart,
      );
      if (gap) start = gap.start;
    }
    if (!onlyWhitespaceBefore(code, start)) return code;

    // Where it ends (same-line trailing comments included).
    let end = nodeEnd;
    for (const c of comments) {
      if (c.start >= end && !code.slice(end, c.start).includes("\n"))
        end = c.end;
    }
    const newline = code.indexOf("\n", end);
    if (code.slice(end, newline === -1 ? code.length : newline).trim() !== "")
      return code;

    items.push({
      text: code.slice(start, end),
      spec: node.source.value,
      sideEffect: node.specifiers.length === 0,
      start,
      end,
    });
    prevEnd = end;
  }

  const eol = code.includes("\r\n") ? "\r\n" : "\n";
  const matchers = compileConfig(config);

  const segments: string[] = [];
  for (let i = 0; i < items.length; ) {
    let j = i;
    while (j < items.length && items[j].sideEffect === items[i].sideEffect) j++;
    const run = items.slice(i, j);
    segments.push(
      items[i].sideEffect
        ? run.map((x) => x.text).join(eol)
        : renderGroups(run, matchers, eol),
    );
    i = j;
  }

  // Whatever follows the block (const, type, export, a comment, ...) must be
  // separated from the last import by a blank line.
  let tail = code.slice(items[items.length - 1].end);
  const gap = /^\s*/.exec(tail)![0];
  if (gap.length < tail.length && (gap.match(/\n/g) ?? []).length < 2) {
    tail = eol + eol + tail.slice(gap.length);
  }

  return code.slice(0, items[0].start) + segments.join(eol + eol) + tail;
}
