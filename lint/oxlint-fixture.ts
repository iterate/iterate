import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");

type Diagnostic = {
  code: string;
  filename: string;
  message: string;
  labels: { span: { offset: number; length: number; line: number } }[];
};

/**
 * The lint tests' temp project: the real iterate plugin with only `rules` armed (every category
 * off), linted by the real oxlint binary from the project root, so rules see the paths a test
 * writes. `jsPlugins` and `overrides` join the config as written, for a test of a rule the root
 * .oxlintrc.json arms on some paths only. `tsconfig` adds a strict
 * project over the root's *.ts for the type-aware rules.
 */
export function createOxlintFixture(input: {
  rules: Record<string, unknown>;
  jsPlugins?: unknown[];
  overrides?: unknown[];
  tsconfig?: boolean;
}) {
  // Plugins resolve imports against the real cwd; macOS's temporary directory is a symlink.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "iterate-oxlint-")));
  const configPath = join(root, ".oxlintrc.json");
  const off = ["correctness", "nursery", "pedantic", "perf", "restriction", "style", "suspicious"];
  writeFileSync(
    configPath,
    JSON.stringify({
      categories: Object.fromEntries(off.map((category) => [category, "off"])),
      env: { builtin: true, node: true },
      jsPlugins: [join(repoRoot, "lint", "oxlint-plugin-iterate.ts"), ...(input.jsPlugins || [])],
      rules: input.rules,
      overrides: input.overrides || [],
    }),
  );
  if (input.tsconfig)
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          lib: ["ES2022"],
          module: "ESNext",
          moduleResolution: "Bundler",
          noEmit: true,
          strict: true,
          target: "ES2022",
        },
        include: ["*.ts"],
      }),
    );

  const oxlint = (args: string[], format: "json" | "stylish" | "unix") =>
    spawnSync(
      join(repoRoot, "node_modules", ".bin", "oxlint"),
      [...args, "--config", configPath, "--threads", "1", "--format", format],
      { cwd: root, encoding: "utf8" },
    );

  return {
    root,
    write(path: string, contents: string) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), contents);
    },
    read(path: string) {
      return readFileSync(join(root, path), "utf8");
    },
    /** One oxlint run, asserting it exits nonzero with `expectFailure` and zero otherwise. */
    run(
      args: string[],
      options: { format?: "json" | "stylish" | "unix"; expectFailure?: boolean } = {},
    ) {
      const result = oxlint(args, options.format || "stylish");
      if (options.expectFailure) expect(result.status, result.stderr || result.stdout).not.toBe(0);
      else expect(result.status, result.stderr || result.stdout).toBe(0);
      return result;
    },
    /** What one run reports, whatever its exit status, in the order oxlint prints it. */
    diagnostics(args: string[]): Diagnostic[] {
      const result = oxlint(args, "json");
      return (JSON.parse(result.stdout) as { diagnostics: Diagnostic[] }).diagnostics;
    },
    [Symbol.dispose]() {
      rmSync(root, { force: true, recursive: true });
    },
  };
}
