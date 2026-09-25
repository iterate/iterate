import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A fresh directory under the OS temp dir for a test to hold with `using`: removed, with everything
 *  in it, when the test's scope ends, whether its assertions passed or not. */
export function temporaryDirectory() {
  const path = mkdtempSync(join(tmpdir(), "iterate-test-"));
  return { path, [Symbol.dispose]: () => rmSync(path, { recursive: true, force: true }) };
}
