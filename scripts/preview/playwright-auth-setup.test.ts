import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import setup from "../../specs/setup.ts";
import { readOsPlaywrightAuthConfig } from "../../specs/test-support/auth-config.ts";

test("Playwright setup prepares auth once for subsequent fixture reads", async () => {
  await using run = await authEnvironment({ supplied: false, valid: true });
  setup();
  expect(readOsPlaywrightAuthConfig()).toEqual(run.config);
  expect(readOsPlaywrightAuthConfig()).toEqual(run.config);
  expect(await run.dopplerCalls()).toBe("download\n");
});

test("an existing auth environment needs no Doppler lookup", async () => {
  await using run = await authEnvironment({ supplied: true, valid: true });
  setup();
  expect(readOsPlaywrightAuthConfig()).toEqual(run.config);
  expect(await run.dopplerCalls()).toBe("");
});

test("invalid auth configuration fails suite setup", async () => {
  await using run = await authEnvironment({ supplied: false, valid: false });
  expect(() => setup()).toThrow("APP_CONFIG_ITERATE_AUTH__ISSUER");
  expect(await run.dopplerCalls()).toBe("download\n");
});

async function authEnvironment(input: { supplied: boolean; valid: boolean }) {
  const directory = await mkdtemp(join(import.meta.dirname, "auth-setup.ignoreme-"));
  const config = {
    adminApiSecret: "auth-setup-test-secret",
    clientId: "auth-setup-test-client",
    issuer: "http://localhost:4310/api/auth",
    // Setup validates JSON; signing and key validity are exercised by the browser specs.
    forgePrivateJwk: JSON.stringify({ kty: "EC", alg: "ES256", d: "fixture-key" }),
  };
  const auth = {
    APP_CONFIG_ADMIN_API_SECRET: config.adminApiSecret,
    APP_CONFIG_ITERATE_AUTH__CLIENT_ID: config.clientId,
    APP_CONFIG_ITERATE_AUTH__ISSUER: config.issuer,
    AUTH_FORGE_ES256_PRIVATE_JWK: config.forgePrivateJwk,
  };
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
  const originalEnvironment = process.env;
  process.env = { ...originalEnvironment, PATH: `${directory}/bin:${originalEnvironment.PATH}` };
  for (const name of Object.keys(auth)) delete process.env[name];
  if (input.supplied) Object.assign(process.env, auth);
  return {
    config,
    dopplerCalls: () => readFile(join(directory, "doppler-calls"), "utf8"),
    async [Symbol.asyncDispose]() {
      process.env = originalEnvironment;
      await rm(directory, { recursive: true, force: true });
    },
  };
}
