// Guards the generated public itx api: it must track the RpcTarget classes in
// rpc-targets.ts (docstrings + explicit signatures) and the zod schemas they
// use. When this fails, run `pnpm generate:itx-api` and commit the result.
//
// Also proves the artifact's two core promises:
// - package-backed: the generated file typechecks with the exact vendor type
//   packages declared by `iterate` — the same public text agents receive
//   through `__describe().types`. The resource-bounded in-Worker checker uses
//   a compiler-only structural Octokit shim, tested in virtual-project.test.
// - sound: every contract-defining class typechecks with
//   `implements <its generated interface>` injected, so the published
//   interfaces are really what the implementation provides.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { API } from "@typescript/native-preview/unstable/sync";
import {
  generateItxApi,
  generateItxApiGraphSource,
  verifyRpcTargetsSatisfyContract,
} from "../scripts/generate-itx-api.ts";

const generatedPath = fileURLToPath(new URL("./itx-api.generated.ts", import.meta.url));

test("itx-api.generated.ts is fresh (pnpm generate:itx-api)", () => {
  expect(readFileSync(generatedPath, "utf8")).toBe(generateItxApi());
}, 60_000);

test("itx-api-graph.generated.ts is fresh (pnpm generate:itx-api)", () => {
  // Both artifacts come from one generator run but are committed
  // separately — check each against a fresh regeneration.
  const graphPath = fileURLToPath(new URL("./itx-api-graph.generated.ts", import.meta.url));
  expect(readFileSync(graphPath, "utf8")).toBe(
    generateItxApiGraphSource(readFileSync(generatedPath, "utf8")),
  );
}, 60_000);

test("the packages/iterate copy (published as iterate/sdk) is fresh (pnpm generate:itx-api)", () => {
  // packages/iterate is excluded from the root CI pipelines (--filter
  // '!iterate'), so the guard for its copy lives here with the other one.
  const packageCopyPath = fileURLToPath(
    new URL("../../../packages/iterate/src/itx-api.generated.ts", import.meta.url),
  );
  expect(readFileSync(packageCopyPath, "utf8")).toBe(readFileSync(generatedPath, "utf8"));
});

test("the public Stream API excludes raw and test-only Durable Object controls", () => {
  const generated = readFileSync(generatedPath, "utf8");
  for (const forbidden of [
    "durableObjectStub",
    "testRunIdleTeardownNow",
    "testReset",
    "testAppendCoreEvents",
    "testReceiveCrossPostedEvents",
  ]) {
    expect(generated).not.toContain(forbidden);
  }
});

test("itx-api.generated.ts resolves its exact vendor types from iterate's dependencies", () => {
  const script = `
    import type { Project, StreamEvent } from "./itx-api.generated.ts";
    export async function run(itx: Project): Promise<StreamEvent> {
      const [event] = await itx.streams.get("/demo").append({ type: "demo/ping" });
      await itx.repo.edit({ message: "m", path: "a.ts", oldString: "x", newString: "y" });
      return event;
    }
  `;
  // A real package-shaped directory with the generated file, a sample script,
  // and exactly the dependencies installed for packages/iterate. This catches
  // a generated bare type import whose package was not published alongside it.
  const dir = mkdtempSync(path.join(tmpdir(), "itx-api-standalone-"));
  try {
    mkdirSync(path.join(dir, "node_modules"));
    mkdirSync(path.join(dir, "node_modules/@types"));
    symlinkSync(
      fileURLToPath(new URL("../../../packages/iterate/node_modules/octokit", import.meta.url)),
      path.join(dir, "node_modules/octokit"),
      "dir",
    );
    symlinkSync(
      fileURLToPath(new URL("../../../packages/iterate/node_modules/@types/node", import.meta.url)),
      path.join(dir, "node_modules/@types/node"),
      "dir",
    );
    writeFileSync(path.join(dir, "itx-api.generated.ts"), readFileSync(generatedPath, "utf8"));
    writeFileSync(path.join(dir, "script.ts"), script);
    writeFileSync(
      path.join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "es2022",
          module: "esnext",
          moduleResolution: "bundler",
          allowImportingTsExtensions: true,
          // es2022 + esnext.disposable: the surface uses Disposable but
          // nothing from @cloudflare/workers-types.
          lib: ["es2022", "esnext.disposable", "dom"],
          types: ["node"],
        },
        include: ["*.ts"],
      }),
    );
    const api = new API({ cwd: dir });
    try {
      const snapshot = api.updateSnapshot({ openProjects: [path.join(dir, "tsconfig.json")] });
      const project = snapshot.getProject(path.join(dir, "tsconfig.json"));
      if (!project) throw new Error("could not open the standalone project");
      const diagnostics = [
        ...project.program.getSyntacticDiagnostics(),
        ...project.program.getSemanticDiagnostics(),
      ];
      expect(diagnostics.map((d) => `${d.fileName}: ${d.text}`)).toEqual([]);
      snapshot.dispose();
    } finally {
      api.close();
    }
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}, 60_000);

test("rpc-targets.ts satisfies the generated contract (implements-injection check)", () => {
  verifyRpcTargetsSatisfyContract(readFileSync(generatedPath, "utf8"));
}, 60_000);
