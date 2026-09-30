import { tmpdir } from "node:os";
import { existsSync, readFileSync, writeFileSync, mkdtempDisposableSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";

/**
 * A `doppler` on PATH for a script's tests, as env-context.ts calls it: `secrets download` prints
 * `secrets` for whatever project and config it names, keeps them in the `--fallback` file it is
 * given, and with `--fallback-only` prints that file's instead, failing when there is none. With
 * `refusal` it fails every call with that message, as the CLI does without a token. `calls()` is
 * each call's arguments.
 */
export function fakeDoppler(
  answer:
    | { secrets: Record<string, string>; refusal?: never }
    | { refusal: string; secrets?: never },
) {
  const directory = mkdtempDisposableSync(join(tmpdir(), "iterate-test-"));
  const path = (name: string) => join(directory.path, name);
  writeFileSync(path("answer.json"), JSON.stringify(answer));
  writeFileSync(
    path("doppler"),
    `#!${process.execPath}
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(path("calls"))}, JSON.stringify(args) + "\\n");
const answer = JSON.parse(readFileSync(${JSON.stringify(path("answer.json"))}, "utf8"));
if (answer.refusal) {
  process.stderr.write(answer.refusal);
  process.exit(1);
}
const fallback = args.includes("--fallback") ? args[args.indexOf("--fallback") + 1] : undefined;
if (args.includes("--fallback-only")) {
  if (!fallback || !existsSync(fallback)) {
    process.stderr.write("Doppler Error: Unable to read fallback file");
    process.exit(1);
  }
  process.stdout.write(readFileSync(fallback, "utf8"));
  process.exit(0);
}
if (fallback) writeFileSync(fallback, JSON.stringify(answer.secrets));
process.stdout.write(JSON.stringify(answer.secrets));
`,
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", `${directory.path}:${process.env.PATH}`);
  return {
    /** Each call's arguments, in order. */
    calls: (): string[][] =>
      existsSync(path("calls"))
        ? readFileSync(path("calls"), "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [],
    [Symbol.dispose]: directory[Symbol.dispose],
  };
}
