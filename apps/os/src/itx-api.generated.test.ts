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
  buildItxApiGraph,
  generateItxApi,
  generateItxApiGraphSource,
  verifyRpcTargetsSatisfyContract,
} from "../scripts/generate-itx-api.ts";
import { declarationsByName, typeSlice } from "./domains/itx/itx-api-graph.ts";

const generatedPath = fileURLToPath(new URL("./itx-api.generated.ts", import.meta.url));

test("namespace generation preserves local aliases, generics, and nested type declarations", () => {
  const sourcePath = fileURLToPath(new URL("./lib/model-interception.ts", import.meta.url));
  const source = readFileSync(sourcePath, "utf8").replace(
    "export declare namespace ProjectAiInterceptor {",
    `export declare namespace ProjectAiInterceptor {
      export type Identity<Value> = Value;
      export type Turn = AgentTurnInput;
      export namespace Nested {
        export interface Envelope { input: Input; options: CfAiRunOptions; }
      }
    `,
  );
  const generated = generateItxApi(
    new Map([
      [
        sourcePath,
        source +
          `
    export declare namespace ProjectAiInterceptor {
      export type OtherTurn = Identity<AgentTurnInput>;
    }
  `,
      ],
    ]),
  );
  expect(generated).toContain("export type Identity<Value> = Value;");
  expect(generated).toContain("export type Turn = AgentTurnInput;");
  expect(generated).toContain("export type OtherTurn = Identity<AgentTurnInput>;");
  const slice = typeSlice({
    declarations: declarationsByName(buildItxApiGraph(generated)),
    rootName: "ProjectAiInterceptor",
    maxTokens: 4_000,
  });
  expect(slice.frontierNames).toEqual([]);
  expect(slice.includedNames).toContain("CfAiRunOptions");
  expect(slice.sourceText).toContain("export namespace Nested");
});

test("namespace generation rejects runtime members", () => {
  const sourcePath = fileURLToPath(new URL("./lib/model-interception.ts", import.meta.url));
  const source = readFileSync(sourcePath, "utf8").replace(
    "export declare namespace ProjectAiInterceptor {",
    "export declare namespace ProjectAiInterceptor { export const runtime: number;",
  );
  expect(() => generateItxApi(new Map([[sourcePath, source]]))).toThrow(
    "requires type-only members in namespace ProjectAiInterceptor",
  );
});

test("same-named namespaces from separate source modules remain ambiguous", () => {
  const otherPath = fileURLToPath(new URL("./domains/itx/itx-api-graph.ts", import.meta.url));
  const otherSource =
    readFileSync(otherPath, "utf8") +
    `
    export declare namespace ProjectAiInterceptor { export type Extra = string; }
  `;
  expect(() => generateItxApi(new Map([[otherPath, otherSource]]))).toThrow(
    'reached ambiguous type "ProjectAiInterceptor"',
  );
});

test("graph groups same-named types and namespaces without confusing local and qualified members", () => {
  const records = buildItxApiGraph(`
    export type Handler = (input: Handler.Input) => Payload;
    export declare namespace Handler {
      export type Input = { payload: Payload; label: "Unrelated" };
      export type Generic<Unrelated> = { value: Unrelated };
    }
    export interface Payload { value: string; }
    export declare namespace Payload { export type Input = boolean; }
    export type Use = Handler.Input | Payload.Input;
    export type Input = { unrelated: true };
    export type Unrelated = { unrelated: true };
  `);
  const declarations = declarationsByName(records);
  expect(records.map((record) => record.name)).toEqual([
    "Handler",
    "Payload",
    "Use",
    "Input",
    "Unrelated",
  ]);
  expect(declarations.get("Handler")).toMatchObject({
    kind: "namespace",
    referencedTypeNames: ["Payload"],
  });
  expect(declarations.get("Payload")).toMatchObject({ kind: "namespace", referencedTypeNames: [] });
  expect(declarations.get("Use")).toMatchObject({ referencedTypeNames: ["Handler", "Payload"] });
  expect(typeSlice({ declarations, rootName: "Use", maxTokens: 2_000 })).toMatchObject({
    includedNames: ["Use", "Handler", "Payload"],
    frontierNames: [],
  });
});

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
    "testReceiveCopiedEvents",
  ]) {
    expect(generated).not.toContain(forbidden);
  }
});

test("itx-api.generated.ts resolves its exact vendor types from iterate's dependencies", () => {
  const script = `
    import type { Project, StreamEvent, ProjectAiInterceptor } from "./itx-api.generated.ts";
    const agentTurn = (input: ProjectAiInterceptor.AgentTurnInput): Response => {
      const messages: { role: "system" | "developer" | "user" | "assistant"; content: string }[] =
        input.request.body.messages;
      // @ts-expect-error agent turns always have typed messages
      input.request.body.messages = [123];
      return Response.json({ agentPath: input.agentPath, messages });
    };
    const aiRun = (input: ProjectAiInterceptor.AiRunInput): Response => {
      input.request.body = { text: ["embeddings need no messages"], steps: 20 };
      // @ts-expect-error arbitrary ai-run bodies do not promise typed messages
      const messages: { content: string }[] = input.request.body.messages;
      // @ts-expect-error only agent turns have an agent path
      input.agentPath;
      return Response.json(input.request.body);
    };
    const egress = (input: ProjectAiInterceptor.EgressInput): Response => {
      input.request.body = { input: "outbound model input" };
      // @ts-expect-error outbound requests do not promise typed agent messages
      const messages: { content: string }[] = input.request.body.messages;
      // @ts-expect-error only agent turns have an agent path
      input.agentPath;
      return Response.json(input.request.body);
    };
    const intercept: ProjectAiInterceptor = (input: ProjectAiInterceptor.Input) => {
      if (input.source === "agent-turn") return agentTurn(input);
      // @ts-expect-error the discriminator excludes the agent-turn variant here
      agentTurn(input);
      if (input.source === "ai-run") return aiRun(input);
      return egress(input);
    };
    export async function run(itx: Project): Promise<StreamEvent> {
      const interception = await itx.ai.intercept(intercept);
      await interception.release();
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
