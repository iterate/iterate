import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "vitest";

const command = resolve(import.meta.dirname, "dependencies.mjs");

test("source-only changes preserve the dependency fingerprint", () => {
  using workspace = fixture();
  const before = workspace.run("fingerprint");
  workspace.write("app/index.js", "module.exports = 99;\n");

  expect(workspace.run("fingerprint")).toBe(before);
});

test.each([
  ["pnpm-lock.yaml", "lockfileVersion: '9.0'\n# changed lock input\n"],
  ["pnpm-workspace.yaml", "packages:\n  - app\n  - another-app\n"],
  [".npmrc", "color=false\n"],
  [".pnpmfile.cjs", "module.exports = { hooks: {} };\n"],
  ["patches/change.patch", "new patch input\n"],
  ["external/index.js", "module.exports = 8;\n"],
  // the bake's recipe: its runner, its Node, the tags it snapshots
  [".depot/workflows/build-preview-ci-image.yml", "runs-on: depot-ubuntu-26.04-16\n"],
])("changed %s changes the dependency fingerprint", (file, contents) => {
  using workspace = fixture();
  const before = workspace.run("fingerprint");
  workspace.write(file, contents);
  expect(workspace.run("fingerprint")).not.toBe(before);
});

test("a manifest's non-lifecycle scripts and other non-install fields preserve the fingerprint", () => {
  using workspace = fixture();
  const before = workspace.run("fingerprint");
  const manifest = JSON.parse(readFileSync(join(workspace.cwd, "package.json"), "utf8"));
  workspace.write(
    "package.json",
    JSON.stringify({
      ...manifest,
      description: "renamed",
      scripts: { ...manifest.scripts, test: "vitest run", "e2e:soak": "tsx scripts/e2e-soak.ts" },
      exports: { ".": "./index.js" },
    }),
  );
  expect(workspace.run("fingerprint")).toBe(before);
});

test("manifest changes affect the fingerprint even with an unchanged lockfile", () => {
  using workspace = fixture();
  const before = workspace.run("fingerprint");
  const manifest = readFileSync(join(workspace.cwd, "package.json"), "utf8");
  workspace.write("package.json", manifest.replace('"workspace:*"', '"workspace:^"'));
  expect(workspace.run("fingerprint")).not.toBe(before);
});

test.each([
  ["package.json", "pnpm:devPreinstall"],
  ["package.json", "preinstall"],
  ["package.json", "install"],
  ["package.json", "postinstall"],
  ["package.json", "preprepare"],
  ["package.json", "prepare"],
  ["package.json", "postprepare"],
  ["app/package.json", "preinstall"],
  ["app/package.json", "install"],
  ["app/package.json", "postinstall"],
  ["app/package.json", "preprepare"],
  ["app/package.json", "prepare"],
  ["app/package.json", "postprepare"],
])("%s %s prevents sealing dependencies", (file, hook) => {
  using workspace = fixture();
  const manifest = JSON.parse(readFileSync(join(workspace.cwd, file), "utf8"));
  workspace.write(
    file,
    JSON.stringify({
      ...manifest,
      scripts: { [hook]: "node -e \"console.log('lifecycle ran')\"" },
    }),
  );
  expect(() => workspace.run("seal")).toThrow("Cannot seal dependencies");
});

test("local dependency fingerprints distinguish binary contents", () => {
  using workspace = fixture();
  const file = join(workspace.cwd, "external/asset.bin");
  writeFileSync(file, Buffer.from([0x80]));
  const before = workspace.run("fingerprint");
  writeFileSync(file, Buffer.from([0x81]));
  expect(workspace.run("fingerprint")).not.toBe(before);
});

test("a different install environment changes the fingerprint", () => {
  using workspace = fixture();
  const before = workspace.run("fingerprint");
  workspace.env.NODE_ENV = "production";
  expect(workspace.run("fingerprint")).not.toBe(before);
});

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "iterate-baked-deps-"));
  const env = { ...process.env, CI: "true", NODE_ENV: "development" };
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
  write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
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
  return {
    cwd,
    write,
    env,
    run: (mode: "fingerprint" | "seal") => exec(process.execPath, [command, mode]),
    [Symbol.dispose]: () => rmSync(cwd, { recursive: true, force: true }),
  };
}
