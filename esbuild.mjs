import { copyFile } from "node:fs/promises";

import { build } from "esbuild";

await Promise.all([
  build({
    entryPoints: ["vscode-extension/src/extension.ts"],
    outfile: "vscode-extension/dist/extension.js",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    external: ["vscode"],
  }),
]);

await Promise.all([copyFile("README.md", "vscode-extension/README.md")]);
console.log("built");
