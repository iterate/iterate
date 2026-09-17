import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "vitest";

const command = resolve(import.meta.dirname, "dependencies.mjs");

test("a baked workspace reuses dependencies after a source-only checkout", () => {
  using workspace = fixture();
  workspace.run("seal");
  workspace.write("app/index.js", "module.exports = 42;\n");

  expect(workspace.run("install")).toContain("reused baked dependencies");
  expect(workspace.exec("node", ["-e", "console.log(require('local-dependency'))"]).trim()).toBe(
    "42",
  );
});

test.each([
  ["pnpm-lock.yaml", "\n# changed lock input\n"],
  [".npmrc", "color=false\n"],
  ["patches/change.patch", "new patch input\n"],
  ["external/index.js", "module.exports = 8;\n"],
])("changed %s runs a frozen install", (file, contents) => {
  using workspace = fixture();
  workspace.run("seal");
  const before = file === "pnpm-lock.yaml" ? readFileSync(join(workspace.cwd, file), "utf8") : "";
  workspace.write(file, before + contents);
  expect(workspace.run("install")).toContain("install required: dependency inputs changed");
});

test("a changed manifest with an unchanged lockfile still fails the frozen install", () => {
  using workspace = fixture();
  workspace.run("seal");
  const manifest = readFileSync(join(workspace.cwd, "package.json"), "utf8");
  workspace.write("package.json", manifest.replace('"workspace:*"', '"workspace:^"'));
  expect(() => workspace.run("install")).toThrow(
    expect.objectContaining({
      status: 1,
      stdout: expect.stringContaining("ERR_PNPM_OUTDATED_LOCKFILE"),
    }),
  );
  workspace.write("package.json", manifest);
  expect(workspace.run("install")).toContain("install required: no baked fingerprint");
});

test("a removed package link is repaired instead of trusting the matching fingerprint", () => {
  using workspace = fixture();
  workspace.run("seal");
  rmSync(join(workspace.cwd, "node_modules/local-dependency"));
  expect(workspace.run("install")).toContain("install required: installed state changed");
  expect(workspace.exec("node", ["-e", "console.log(require('local-dependency'))"]).trim()).toBe(
    "42",
  );
});

test("an unsealed image follows the existing install path", () => {
  using workspace = fixture();
  expect(workspace.run("install")).toContain("install required: no baked fingerprint");
});

test("new workspace lifecycle scripts cannot silently be skipped", () => {
  using workspace = fixture();
  workspace.write(
    "app/package.json",
    JSON.stringify({
      name: "local-dependency",
      version: "1.0.0",
      scripts: { prepare: "node -e \"console.log('lifecycle ran')\"" },
    }),
  );
  expect(() => workspace.run("seal")).toThrow("Cannot seal dependencies");
  expect(workspace.run("install")).toContain("lifecycle ran");
});

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "iterate-baked-deps-"));
  const env = { ...process.env, CI: "true" };
  function write(path: string, contents: string) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), contents);
  }
  function exec(file: string, args: string[]) {
    return execFileSync(file, args, {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  write(
    "package.json",
    JSON.stringify({
      private: true,
      packageManager: "pnpm@10.24.0",
      dependencies: { "local-dependency": "workspace:*", "local-external": "file:./external" },
    }),
  );
  write("pnpm-workspace.yaml", "packages:\n  - app\n");
  write(
    "app/package.json",
    JSON.stringify({ name: "local-dependency", version: "1.0.0", main: "index.js" }),
  );
  write("app/index.js", "module.exports = 42;\n");
  write(
    "external/package.json",
    JSON.stringify({ name: "local-external", version: "1.0.0", main: "index.js" }),
  );
  write("external/index.js", "module.exports = 7;\n");
  write(".gitignore", "node_modules\n");
  exec("git", ["init", "-q"]);
  exec("git", ["add", "."]);
  exec("pnpm", ["install"]);
  return {
    cwd,
    write,
    exec,
    run: (mode: string) => exec("node", [command, mode]),
    [Symbol.dispose]: () => rmSync(cwd, { recursive: true, force: true }),
  };
}
