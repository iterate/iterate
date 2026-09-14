import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { exportJWK, generateKeyPair } from "jose";
import { expect, test } from "vitest";

test("Playwright prepares auth once and both workers inherit it", async () => {
  await using run = await playwrightAuth({ supplied: false, valid: true });
  const result = await run.result;
  expect(result, result.output).toMatchObject({ code: 0 });
  expect(await readFile(join(run.directory, "doppler-calls"), "utf8")).toBe("download\n");
  expect(await run.sessions()).toHaveLength(2);
});

test("an existing auth environment needs no Doppler lookup", async () => {
  await using run = await playwrightAuth({ supplied: true, valid: true });
  const result = await run.result;
  expect(result, result.output).toMatchObject({ code: 0 });
  expect(await readFile(join(run.directory, "doppler-calls"), "utf8")).toBe("");
  expect(await run.sessions()).toHaveLength(2);
});

test("invalid auth configuration fails setup before either worker runs a test", async () => {
  await using run = await playwrightAuth({ supplied: false, valid: false });
  const result = await run.result;
  expect(result).toMatchObject({ code: 1 });
  expect(result.output).toContain("APP_CONFIG_ITERATE_AUTH__ISSUER");
  expect(await run.sessions()).toEqual([]);
});

async function playwrightAuth(input: { supplied: boolean; valid: boolean }) {
  const repo = resolve(import.meta.dirname, "../..");
  const directory = await mkdtemp(join(repo, "scripts/preview/auth-setup.ignoreme-"));
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const auth = {
    APP_CONFIG_ADMIN_API_SECRET: "auth-setup-test-secret",
    APP_CONFIG_ITERATE_AUTH__CLIENT_ID: "auth-setup-test-client",
    APP_CONFIG_ITERATE_AUTH__ISSUER: "http://localhost:4310/api/auth",
    AUTH_FORGE_ES256_PRIVATE_JWK: JSON.stringify({
      ...(await exportJWK(privateKey)),
      alg: "ES256",
    }),
  };
  await writeFile(join(directory, "sessions"), "");
  await writeFile(join(directory, "doppler-calls"), "");
  await mkdir(join(directory, "bin"));
  await writeFile(
    join(directory, "bin/doppler"),
    `#!${process.execPath}
import * as fs from "node:fs";
fs.appendFileSync(${JSON.stringify(join(directory, "doppler-calls"))}, "download\\n");
process.stdout.write(${JSON.stringify(JSON.stringify(input.valid ? auth : {}))});
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(directory, "playwright.config.ts"),
    `export default {
  globalSetup: ${JSON.stringify(join(repo, "specs/setup.ts"))},
  workers: 2,
  fullyParallel: true,
  retries: 0,
  reporter: "line",
  testMatch: "fixture.spec.ts",
};
`,
  );
  await writeFile(
    join(directory, "fixture.spec.ts"),
    `import { test, expect } from "@playwright/test";
import { appendFileSync } from "node:fs";
import { decodeJwt } from "jose";
import { mintIterateSession } from ${JSON.stringify(join(repo, "specs/test-support/forged-session.ts"))};
for (const email of ["first@test.localhost", "second@test.localhost"]) {
  test(email, async () => {
    const session = await mintIterateSession({
      baseUrl: "http://localhost:4311", email, organizations: [], projects: [],
    });
    expect(decodeJwt(session.idToken)).toMatchObject({
      email, aud: "auth-setup-test-client", iss: "http://localhost:4310/api/auth",
    });
    appendFileSync(${JSON.stringify(join(directory, "sessions"))}, email + "\\n");
  });
}
`,
  );
  const environment = { ...process.env };
  for (const name of Object.keys(auth)) delete environment[name];
  if (input.supplied) Object.assign(environment, auth);
  environment.PATH = `${directory}/bin:${process.env.PATH}`;
  const result = promisify(execFile)(
    process.execPath,
    [
      join(repo, "node_modules/playwright/cli.js"),
      "test",
      "--config",
      join(directory, "playwright.config.ts"),
    ],
    { cwd: repo, env: environment, timeout: 20_000 },
  ).then(
    ({ stdout, stderr }) => ({ code: 0, output: stdout + stderr }),
    (error) => ({ code: error.code, output: error.stdout + error.stderr }),
  );
  return {
    directory,
    result,
    sessions: async () =>
      (await readFile(join(directory, "sessions"), "utf8")).trim().split("\n").filter(Boolean),
    async [Symbol.asyncDispose]() {
      await result;
      await rm(directory, { recursive: true, force: true });
    },
  };
}
