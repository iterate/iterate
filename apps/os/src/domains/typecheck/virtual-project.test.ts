// These tests run the REAL tswasm compiler (the same wasm the typechecker
// sidecar ships) against the assembled virtual project, so "the platform
// surface compiles clean under the sidecar's lib + shims" is a tested
// invariant, not a hope. No network: scripts here import no npm packages, so
// typm never fires.
import { createCompiler } from "tswasm";
import { beforeAll, expect, test } from "vitest";
import type { CapabilityDescription } from "../itx/describe.ts";
import type { CompileFn } from "./run-typecheck.ts";
import { runTypecheck, npmPackagesMentioned } from "./run-typecheck.ts";
import {
  checkCapabilityTypes,
  checkItxScript,
  mountModuleText,
  type Typechecker,
} from "./virtual-project.ts";

let typechecker: Typechecker;

beforeAll(async () => {
  const compiler = await createCompiler();
  typechecker = {
    check: (input) =>
      runTypecheck({
        compiler: compiler as CompileFn,
        fetchImpl: () => Promise.reject(new Error("network is off in unit tests")),
        files: input.files,
      }),
  };
});

const WEATHER_MOUNT: CapabilityDescription = {
  path: ["tools", "weather"],
  type: "itx-expression",
  instructions: "Three-day forecasts.",
  types: "export type Forecast = { forecast(input: { city: string }): Promise<string> };",
};

test("the platform surface compiles clean under the sidecar's lib and shims", async () => {
  const problems = await checkItxScript({
    capabilities: [],
    code: "async (itx) => {}",
    typechecker,
  });
  expect(problems).toEqual([]);
});

test("a wrong call into the typed surface is a compiler error with a did-you-mean", async () => {
  const problems = await checkItxScript({
    capabilities: [],
    code: `async (itx) => {\n  return await itx.streams.gett("/");\n}`,
    typechecker,
  });
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain("script:2");
  expect(problems[0]).toContain("gett");
  expect(problems[0]).toContain("Did you mean 'get'");
});

test("typed mounts join the itx type; untyped mounts stay permissive", async () => {
  const capabilities: CapabilityDescription[] = [
    WEATHER_MOUNT,
    { path: ["legacy"], type: "live" }, // no types recorded → any
  ];
  const ok = await checkItxScript({
    capabilities,
    code: `async (itx) => {\n  await itx.legacy.anything(1, 2);\n  return await itx.tools.weather.forecast({ city: "Berlin" });\n}`,
    typechecker,
  });
  expect(ok).toEqual([]);

  const typo = await checkItxScript({
    capabilities,
    code: `async (itx) => itx.tools.weather.forecast({ city: 42 })`,
    typechecker,
  });
  expect(typo).toHaveLength(1);
  expect(typo[0]).toContain("number");
});

test("mount types referencing platform declarations resolve bare", async () => {
  const problems = await checkCapabilityTypes({
    types: "export type Root = { tail(): Promise<StreamEvent[]> };",
    typechecker,
  });
  expect(problems).toEqual([]);
  expect(mountModuleText("export type Root = Stream;")).toContain(
    'import type { Stream } from "../itx-types";',
  );
});

test("a typo'd capability types string is rejected with a compiler error", async () => {
  const problems = await checkCapabilityTypes({
    types: "export type Broken = { list(): Promise<Streem[]> };",
    typechecker,
  });
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain("Streem");
});

test("npm specifier scan finds bare packages and ignores relative/node ones", () => {
  const files = {
    "/mounts/slack.ts": 'export type Slack = import("@slack/web-api").WebClient;',
    "/script.ts": 'import { z } from "zod/v4";\nimport "./local";\nimport fs from "node:fs";',
    "/node_modules/zod/index.d.ts": 'import "left-pad";', // acquired files never re-scan
  };
  expect(npmPackagesMentioned(files).sort()).toEqual(["@slack/web-api", "zod"]);
});
