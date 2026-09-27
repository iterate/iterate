import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { temporaryDirectory } from "@iterate-com/shared/test-support/temporary-directory";
import { expect, test } from "vitest";

const script = resolve(import.meta.dirname, "toolchain.sh");

test("a job takes .nvmrc's Node, the newest of that major, from the stock image's tool cache", () => {
  using job = fixture();
  job.imageNode("22.23.2");
  job.imageNode("24.9.0");
  job.imageNode("24.21.0");

  const result = job.run("node");

  expect(result).toMatchObject({
    status: 0,
    stdout: `Node v24.21.0 from ${job.cache}/24.21.0/x64/bin\n`,
    stderr: "",
  });
  expect(readFileSync(job.githubPath, "utf8")).toBe(`${job.cache}/24.21.0/x64/bin\n`);
});

test("an image without .nvmrc's Node makes the job warn, then take it from nodejs.org, checked against its SHASUMS256.txt", () => {
  using job = fixture();
  job.imageNode("22.23.2");
  job.release("24.99.0");

  const result = job.run("node");

  expect(result).toMatchObject({
    status: 0,
    stdout: `Node v24.99.0 from ${job.tools}/node/bin\n`,
    stderr: expect.stringContaining("::warning title=Node from nodejs.org::"),
  });
  expect(readFileSync(job.githubPath, "utf8")).toBe(`${job.tools}/node/bin\n`);
});

test("a download that does not match its SHASUMS256.txt fails the job, and puts nothing on the PATH", () => {
  using job = fixture();
  job.release("24.99.0", { corrupt: true });

  const result = job.run("node");

  expect(result).toMatchObject({ status: 1, stderr: expect.stringContaining("FAILED") });
  expect(readFileSync(job.githubPath, "utf8")).toBe("");
});

function fixture() {
  const root = temporaryDirectory();
  const cache = join(root.path, "hostedtoolcache", "node");
  const dist = join(root.path, "dist");
  const runnerTemp = join(root.path, "runner-temp");
  const githubPath = join(root.path, "github-path");
  mkdirSync(cache, { recursive: true });
  mkdirSync(runnerTemp);
  writeFileSync(githubPath, "");
  writeFileSync(join(root.path, ".nvmrc"), "24\n");
  const fakeNode = (version: string) => `#!/bin/sh\necho v${version}\n`;
  return {
    cache,
    githubPath,
    tools: join(runnerTemp, "toolchain"),
    /** A Node in the image's tool cache, as /opt/hostedtoolcache/node lays it out. */
    imageNode(version: string) {
      const bin = join(cache, version, "x64", "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "node"), fakeNode(version));
      chmodSync(join(bin, "node"), 0o755);
    },
    /** nodejs.org's latest-v<major>.x release of `version`: its linux-x64 tarball and SHASUMS256.txt. */
    release(version: string, options: { corrupt?: boolean } = {}) {
      const name = `node-v${version}-linux-x64`;
      const build = join(root.path, "build", name, "bin");
      mkdirSync(build, { recursive: true });
      writeFileSync(join(build, "node"), fakeNode(version));
      chmodSync(join(build, "node"), 0o755);
      const release = join(dist, `latest-v${version.split(".")[0]}.x`);
      mkdirSync(release, { recursive: true });
      const tarball = join(release, `${name}.tar.xz`);
      spawnSync("tar", ["-cJf", tarball, "-C", join(root.path, "build"), name]);
      const sum = createHash("sha256")
        .update(readFileSync(tarball))
        .update(options.corrupt ? "x" : "")
        .digest("hex");
      writeFileSync(
        join(release, "SHASUMS256.txt"),
        `${"0".repeat(64)}  ${name}.tar.gz\n${sum}  ${name}.tar.xz\n`,
      );
    },
    run: (command: string) =>
      spawnSync("bash", [script, command], {
        cwd: root.path,
        encoding: "utf8",
        env: {
          ...process.env,
          RUNNER_TEMP: runnerTemp,
          GITHUB_PATH: githubPath,
          TOOLCHAIN_NODE_CACHE: cache,
          TOOLCHAIN_NODE_DIST: `file://${dist}`,
        },
      }),
    [Symbol.dispose]: root[Symbol.dispose],
  };
}
