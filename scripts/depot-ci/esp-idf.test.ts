import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

const script = resolve(import.meta.dirname, "esp-idf.sh");

test("a leg whose image receipt matches the script uses the image's ESP-IDF and downloads nothing", () => {
  using leg = fixture();
  leg.writeReceipt(leg.scriptHash());

  const result = leg.ensure();

  expect(result).toMatchObject({
    status: 0,
    stdout: expect.stringContaining("Using the CI image's ESP-IDF v5.4.2"),
  });
  expect(result.stdout).not.toContain("::warning::");
  expect(readFileSync(leg.githubEnv, "utf8")).toBe(
    `IDF_PATH=${leg.idfPath}\nIDF_TOOLS_PATH=${leg.toolsPath}\n`,
  );
});

test.each([
  ["an image without ESP-IDF", undefined],
  ["an image baked from another esp-idf.sh", "0000000000000000000000000000000000000000"],
])("%s makes the leg warn, then install from the network", (_, receipt) => {
  using leg = fixture();
  if (receipt) leg.writeReceipt(receipt);

  const result = leg.ensure();

  expect(result).toMatchObject({
    stdout: expect.stringContaining(
      `::warning::The CI image's ESP-IDF receipt (${receipt || "none"}) is not scripts/depot-ci/esp-idf.sh (${leg.scriptHash()})`,
    ),
    // The fixture routes the clone to a missing repository, so the install fails at its first
    // download, as a broken download fails a real leg.
    stderr: expect.stringContaining("/nonexistent/esp-idf.git"),
    status: 128,
  });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "iterate-esp-idf-"));
  const idfPath = join(root, "esp-idf");
  const toolsPath = join(root, "espressif");
  const githubEnv = join(root, "github-env");
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
    scriptHash: () => spawnSync("git", ["hash-object", script], { encoding: "utf8" }).stdout.trim(),
    writeReceipt(contents: string) {
      mkdirSync(toolsPath, { recursive: true });
      writeFileSync(join(toolsPath, "iterate-esp-idf.receipt"), `${contents}\n`);
    },
    ensure: () => spawnSync(script, ["ensure"], { env, encoding: "utf8" }),
    [Symbol.dispose]: () => rmSync(root, { recursive: true, force: true }),
  };
}
