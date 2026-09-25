import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";

// No private key is ever committed: a PEM `BEGIN … PRIVATE KEY` line FOLLOWED BY base64 body lines
// fails this test, naming the file and line. A header on its own — a doc comment, or a stub a test
// feeds a parser to be refused — is fine. A throwaway key a test or a preview needs is generated
// where it is used (node:crypto `generateKeyPairSync`) or read from Doppler at deploy time. GitHub's
// secret scanning raised "Generic Private Key" on a throwaway preview key committed in #3063
// (2026-09-24). Deliberately dumb and fast: git ls-files plus a line scan.

const repoRoot = resolve(import.meta.dirname, "..");
const PEM_PRIVATE_KEY_HEADER = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const BASE64_BODY_LINE = /^[A-Za-z0-9+/=]{40,}$/;

test("no tracked file holds a PEM private key body — generate a throwaway where it is used, or read it from Doppler", () => {
  expect(committedPrivateKeys()).toEqual([]);
});

/** Every `file:line` whose private-key header is followed by a base64 key body (the next non-blank
 *  line, a string's `\n` escapes split into lines too, a JSON-in-JSON `\\n` as well). */
function committedPrivateKeys(): string[] {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" })
    .split("\0")
    .filter(
      (file) =>
        file && !/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|zip|gz|wasm|bin)$/i.test(file),
    );
  const found: string[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(resolve(repoRoot, file), "utf8");
    } catch {
      continue; // a submodule or a file deleted in the working tree
    }
    if (!PEM_PRIVATE_KEY_HEADER.test(text)) continue;
    const lines = text.replaceAll("\\n", "\n").split("\n");
    lines.forEach((line, index) => {
      if (!PEM_PRIVATE_KEY_HEADER.test(line)) return;
      const next = lines.slice(index + 1).find((candidate) => candidate.trim());
      // a key inside a string: its quotes, and the backslash of a doubly escaped `\\n`
      const body = next?.trim().replace(/^["'`\\]+|["'`,\\]+$/g, "") ?? "";
      if (BASE64_BODY_LINE.test(body)) found.push(`${file}:${index + 1}`);
    });
  }
  return found;
}
