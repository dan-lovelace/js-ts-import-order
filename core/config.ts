import * as fs from "node:fs";
import { builtinModules } from "node:module";
import * as path from "node:path";

/** Key read from the nearest package.json that contains it. */
export const CONFIG_KEY = "jsTsImports";

/**
 * Every list holds module-specifier patterns. `*` matches any characters.
 * A pattern without `*` matches the package and its subpaths:
 * `react` matches `react` and `react/jsx-runtime`, but not `react-dom`.
 */
export interface ImportOrderConfig {
  /** Node built-ins. Replaces the default list when set. `node:*` is always built-in. */
  builtins: string[];
  /** Forced to "external". Checked before `internal`. */
  external: string[];
  /** Project/workspace packages and aliases, e.g. "@packages/*", "@/*". */
  internal: string[];
  /** Float to the top of whichever package group they land in, in the order given. */
  priority: string[];
}

export const DEFAULT_CONFIG: ImportOrderConfig = {
  builtins: builtinModules.filter((m) => !m.startsWith("_")),
  external: [],
  // Safe defaults: none of these can be a real npm package name.
  internal: ["#*", "@/*", "~/*"],
  priority: [],
};

export function resolveConfig(
  raw: unknown,
  source = "package.json",
): ImportOrderConfig {
  if (raw === undefined) return DEFAULT_CONFIG;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${source}: "${CONFIG_KEY}" must be an object.`);
  }
  const input = raw as Record<string, unknown>;
  const known = Object.keys(DEFAULT_CONFIG);
  for (const key of Object.keys(input)) {
    if (!known.includes(key)) {
      throw new Error(
        `${source}: unknown option "${CONFIG_KEY}.${key}". Known options: ${known.join(", ")}.`,
      );
    }
  }
  const out: ImportOrderConfig = { ...DEFAULT_CONFIG };
  for (const key of known as (keyof ImportOrderConfig)[]) {
    const value = input[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
      throw new Error(
        `${source}: "${CONFIG_KEY}.${key}" must be an array of strings.`,
      );
    }
    out[key] = value;
  }
  return out;
}

/**
 * Walks up from the file's directory and uses the first package.json that has
 * a `jsTsImports` key (so monorepo packages can inherit from the root).
 * Falls back to defaults when none is found or no file path is given.
 */
export function loadConfig(filePath?: string): ImportOrderConfig {
  if (!filePath) return DEFAULT_CONFIG;
  let dir = path.dirname(path.resolve(filePath));
  for (;;) {
    const pkgPath = path.join(dir, "package.json");
    let pkg: unknown;
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    } catch {
      // missing or unparsable package.json: keep walking up
    }
    if (pkg && typeof pkg === "object" && CONFIG_KEY in pkg) {
      return resolveConfig(
        (pkg as Record<string, unknown>)[CONFIG_KEY],
        pkgPath,
      );
    }
    const parent = path.dirname(dir);
    if (parent === dir) return DEFAULT_CONFIG;
    dir = parent;
  }
}
