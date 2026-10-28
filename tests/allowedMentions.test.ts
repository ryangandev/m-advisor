import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const SRC = join(__dirname, "..", "src");
/** Interaction responses that can carry text. Autocomplete `respond` and `deferReply` send no message body. */
const RESPONSE_CALL = /\binteraction\.(reply|editReply|followUp|update)\(/g;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/** The text between the call's parentheses, skipping string literals so a bracket inside a message cannot end it early. */
function callArguments(source: string, open: number): string {
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    const char = source[index];
    if (char === "'" || char === '"' || char === "`") {
      for (index++; index < source.length && source[index] !== char; index++) if (source[index] === "\\") index++;
    } else if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return source.slice(open + 1, index);
  }
  throw new Error("unbalanced call");
}

test("every interaction response in src sets allowedMentions explicitly", () => {
  const missing: string[] = [];
  let checked = 0;
  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(RESPONSE_CALL)) {
      checked++;
      const args = callArguments(source, match.index + match[0].length - 1);
      if (!/\ballowedMentions\b/.test(args)) {
        const line = source.slice(0, match.index).split("\n").length;
        missing.push(`${relative(SRC, file)}:${line} ${match[0]}`);
      }
    }
  }
  assert.ok(checked > 30, `the scan found only ${checked} responses, so it is probably broken`);
  assert.deepEqual(missing, []);
});

test("the Discord client mentions nobody by default", () => {
  const source = readFileSync(join(SRC, "index.ts"), "utf8");
  assert.match(source, /allowedMentions:\s*\{\s*parse:\s*\[\],\s*repliedUser:\s*false\s*\}/);
});
