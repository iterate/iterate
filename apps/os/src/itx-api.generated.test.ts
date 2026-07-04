// Guards the generated public itx api: it must track the RpcTarget classes in
// rpc-targets.ts (docstrings + explicit signatures) and the zod schemas they
// use. When this fails, run `pnpm generate:itx-api` and commit the result.
//
// Also proves the artifact's core promise: the generated file is a standalone,
// import-free module an itx script can typecheck against with no access to the
// monorepo — the same text agents receive over `__describe().types`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import ts from "typescript";
import { generateItxApi } from "../scripts/generate-itx-api.ts";

const generatedPath = fileURLToPath(new URL("./itx-api.generated.ts", import.meta.url));

test("itx-api.generated.ts is fresh (pnpm generate:itx-api)", () => {
  expect(readFileSync(generatedPath, "utf8")).toBe(generateItxApi());
}, 60_000);

test("itx-api.generated.ts is a standalone module (itx scripts can typecheck against it alone)", () => {
  const source = readFileSync(generatedPath, "utf8");
  const script = `
    import type { Itx, StreamEvent } from "./itx-api.generated.ts";
    export async function run(itx: Itx): Promise<StreamEvent> {
      const [event] = await itx.streams.get("/demo").append({ type: "demo/ping" });
      await itx.repo.edit({ message: "m", path: "a.ts", oldString: "x", newString: "y" });
      return event;
    }
  `;
  const files = new Map<string, string>([
    ["/itx-api.generated.ts", source],
    ["/script.ts", script],
  ]);
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    // es2022 + esnext.disposable: the surface uses Disposable but nothing DOM
    // and nothing from @cloudflare/workers-types.
    lib: ["lib.es2022.d.ts", "lib.esnext.disposable.d.ts", "lib.dom.d.ts"],
  };
  const host = ts.createCompilerHost(options);
  const defaultReadFile = host.readFile.bind(host);
  const defaultFileExists = host.fileExists.bind(host);
  host.readFile = (fileName) => files.get(fileName) ?? defaultReadFile(fileName);
  host.fileExists = (fileName) => files.has(fileName) || defaultFileExists(fileName);
  const program = ts.createProgram(["/script.ts"], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  expect(diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
}, 60_000);
