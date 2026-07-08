// Guards the generated public itx api: it must track the RpcTarget classes in
// rpc-targets.ts (docstrings + explicit signatures) and the zod schemas they
// use. When this fails, run `pnpm generate:itx-api` and commit the result.
//
// Also proves the artifact's two core promises:
// - standalone: the generated file is an import-free module an itx script can
//   typecheck against with no access to the monorepo — the same text agents
//   receive over `__describe().types`.
// - sound: every contract-defining class typechecks with
//   `implements <its generated interface>` injected, so the published
//   interfaces are really what the implementation provides.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { API } from "@typescript/native-preview/unstable/sync";
import { generateItxApi, verifyRpcTargetsSatisfyContract } from "../scripts/generate-itx-api.ts";

const generatedPath = fileURLToPath(new URL("./itx-api.generated.ts", import.meta.url));

test("itx-api.generated.ts is fresh (pnpm generate:itx-api)", () => {
  expect(readFileSync(generatedPath, "utf8")).toBe(generateItxApi());
}, 60_000);

test("itx-api.generated.ts is a standalone module (itx scripts can typecheck against it alone)", () => {
  const script = `
    import type { Project, StreamEvent } from "./itx-api.generated.ts";
    export async function run(itx: Project): Promise<StreamEvent> {
      const [event] = await itx.streams.get("/demo").append({ type: "demo/ping" });
      await itx.repo.edit({ message: "m", path: "a.ts", oldString: "x", newString: "y" });
      return event;
    }
  `;
  // A real directory with ONLY the generated file and a sample script — the
  // native compiler typechecks it with no access to the monorepo.
  const dir = mkdtempSync(path.join(tmpdir(), "itx-api-standalone-"));
  try {
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
          types: [],
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
