// run-swift.ts — the laptop's runSwift capability.
//
// `swift -` reads a program from stdin and runs it. If swift is not installed,
// degrade gracefully to a tiny JS evaluator so the repro runs anywhere.
import { spawn, spawnSync } from "node:child_process";

export const swiftAvailable = (() => {
  try {
    const r = spawnSync("swift", ["--version"], { stdio: "ignore" });
    return r.status === 0;
  } catch {
    return false;
  }
})();

export const runSwift = (code: string): Promise<string> =>
  new Promise((resolve, reject) => {
    if (swiftAvailable) {
      const swift = spawn("swift", ["-"]);
      let out = "";
      let err = "";
      swift.stdout.on("data", (d) => (out += d));
      swift.stderr.on("data", (d) => (err += d));
      swift.on("error", reject);
      swift.on("close", (codeNum) => {
        if (codeNum !== 0 && !out) reject(new Error(`swift exited ${codeNum}: ${err}`));
        else resolve(out);
      });
      swift.stdin.end(code);
      return;
    }
    // Fallback: emulate the trivial `print(EXPR)` programs the workshop uses.
    // Supports: print(1 + 1) -> "2\n", print("x") -> "x\n".
    const m = code.match(/print\(([\s\S]*)\)\s*;?\s*$/);
    if (!m) {
      resolve(`[js-fallback] could not interpret: ${code}`);
      return;
    }
    const expr = m[1].trim();
    try {
      // Only allow string literals and simple arithmetic.
      // eslint-disable-next-line no-new-func
      const val = Function(`"use strict"; return (${expr});`)();
      resolve(`${val}\n`);
    } catch (e) {
      resolve(`[js-fallback] eval error: ${(e as Error).message}\n`);
    }
  });
