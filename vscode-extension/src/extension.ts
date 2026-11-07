import * as vscode from "vscode";

import { loadConfig, sortImports } from "../../core";

/** Use in settings: "editor.codeActionsOnSave": { "source.jsTsImports": "explicit" } */
const KIND = vscode.CodeActionKind.Source.append("jsTsImports");
const LANGUAGES = [
  "javascript",
  "javascriptreact",
  "typescript",
  "typescriptreact",
];

let output: vscode.OutputChannel;

/** Smallest single edit that turns `before` into `after`, so cursor/folds/undo stay sane. */
function minimalEdit(
  doc: vscode.TextDocument,
  before: string,
  after: string,
): vscode.TextEdit | undefined {
  if (before === after) return undefined;
  const max = Math.min(before.length, after.length);
  let start = 0;
  while (start < max && before[start] === after[start]) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (
    endBefore > start &&
    endAfter > start &&
    before[endBefore - 1] === after[endAfter - 1]
  ) {
    endBefore--;
    endAfter--;
  }
  const range = new vscode.Range(
    doc.positionAt(start),
    doc.positionAt(endBefore),
  );
  return vscode.TextEdit.replace(range, after.slice(start, endAfter));
}

function computeEdit(doc: vscode.TextDocument): vscode.TextEdit | undefined {
  const before = doc.getText();
  const isFile = doc.uri.scheme === "file";
  const config = loadConfig(isFile ? doc.uri.fsPath : undefined);
  const after = sortImports(before, config, doc.fileName);
  return minimalEdit(doc, before, after);
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

class SortImportsActions implements vscode.CodeActionProvider {
  provideCodeActions(
    doc: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext,
  ) {
    // Only offered as an explicit source action (Source Action… menu or codeActionsOnSave).
    if (!context.only || !context.only.intersects(KIND)) return [];
    try {
      const edit = computeEdit(doc);
      if (!edit) return [];
      const action = new vscode.CodeAction("Sort imports (JS/TS)", KIND);
      action.edit = new vscode.WorkspaceEdit();
      action.edit.set(doc.uri, [edit]);
      return [action];
    } catch (e) {
      output.appendLine(`${doc.fileName}: ${errorText(e)}`);
      return [];
    }
  }
}

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel("JS/TS Imports");
  context.subscriptions.push(
    output,
    vscode.languages.registerCodeActionsProvider(
      LANGUAGES.map((language) => ({ language })),
      new SortImportsActions(),
      { providedCodeActionKinds: [KIND] },
    ),
    vscode.commands.registerTextEditorCommand(
      "jsTsImports.sort",
      (editor, builder) => {
        try {
          const edit = computeEdit(editor.document);
          if (edit) builder.replace(edit.range, edit.newText);
        } catch (e) {
          vscode.window.showErrorMessage(`JS/TS imports: ${errorText(e)}`);
        }
      },
    ),
  );
}

export function deactivate() {}
