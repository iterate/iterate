import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, mkdtempDisposableSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

const script = resolve(import.meta.dirname, "esp-idf.sh");

test("the key is this script's hash and python3's version, which the Python environment is built for", () => {
  using leg = fixture();

  expect(leg.run("key")).toMatchObject({ status: 0, stdout: `key=${leg.key()}\n` });
  expect(leg.key()).toMatch(/^esp-idf-[0-9a-f]{40}-python3\.\d+$/);
});

test("a leg that restored this key's ESP-IDF from Depot Cache uses it and downloads nothing", () => {
  using leg = fixture();
  leg.writeReceipt(leg.key());

  const result = leg.run("ensure");

  expect(result).toMatchObject({
    status: 0,
    stdout: expect.stringContaining("Using ESP-IDF v6.1 from Depot Cache"),
  });
  expect(result.stdout).not.toContain("::warning::");
  expect(readFileSync(leg.githubEnv, "utf8")).toBe(
    `IDF_PATH=${leg.idfPath}\nIDF_TOOLS_PATH=${leg.toolsPath}\n`,
  );
});

test.for([
  ["a leg that restored no ESP-IDF", () => undefined],
  [
    "a leg that restored another esp-idf.sh's ESP-IDF",
    (key: string) => key.replace(/-[0-9a-f]{40}-/, `-${"0".repeat(40)}-`),
  ],
  [
    "a leg that restored an ESP-IDF built for another python3",
    (key: string) => key.replace(/-python3\.\d+$/, "-python3.0"),
  ],
] as const)("%s makes the leg warn, then install from the network", ([, restored]) => {
  using leg = fixture();
  const receipt = restored(leg.key());
  if (receipt) leg.writeReceipt(receipt);

  const result = leg.run("ensure");

  expect(result).toMatchObject({
    stdout: expect.stringContaining(
      `::warning::No ESP-IDF from Depot Cache for ${leg.key()} (the receipt restored: ${receipt || "none"})`,
    ),
    // The fixture routes the clone to a missing repository, so the install fails at its first
    // download, as a broken download fails a real leg.
    stderr: expect.stringContaining("/nonexistent/esp-idf.git"),
    status: 128,
  });
});

function fixture() {
  const root = mkdtempDisposableSync(join(tmpdir(), "iterate-test-"));
  const idfPath = join(root.path, "esp-idf");
  const toolsPath = join(root.path, "espressif");
  const githubEnv = join(root.path, "github-env");
  writeFileSync(githubEnv, "");
  const env = {
    ...process.env,
    IDF_PATH: idfPath,
    IDF_TOOLS_PATH: toolsPath,
    GITHUB_ENV: githubEnv,
    // Never reach GitHub from a test: send the ESP-IDF clone to a repository that does not exist.
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "url./nonexistent/.insteadOf",
    GIT_CONFIG_VALUE_0: "https://github.com/espressif/",
  };
  return {
    idfPath,
    toolsPath,
    githubEnv,
    key: () =>
      `esp-idf-${command("git", "hash-object", script)}-python${command("python3", "-c", "import sys; print('%d.%d' % sys.version_info[:2])")}`,
    writeReceipt(contents: string) {
      mkdirSync(toolsPath, { recursive: true });
      writeFileSync(join(toolsPath, "iterate-esp-idf.receipt"), `${contents}\n`);
    },
    run: (subcommand: "key" | "ensure") =>
      spawnSync(script, [subcommand], { env, encoding: "utf8" }),
    [Symbol.dispose]: root[Symbol.dispose],
  };
}

function command(...args: [string, ...string[]]) {
  return spawnSync(args[0], args.slice(1), { encoding: "utf8" }).stdout.trim();
}
