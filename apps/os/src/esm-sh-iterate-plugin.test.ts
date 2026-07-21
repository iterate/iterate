import { build } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import { createEsmShIteratePlugin, withEsmShIteratePackage } from "./esm-sh-iterate-plugin.ts";

const PACKAGE_SPEC =
  "https://pkg.pr.new/iterate/iterate/iterate@0123456789abcdef0123456789abcdef01234567";
const ESM_SH_ROOT =
  "https://esm.sh/pr/iterate/iterate/iterate@0123456789abcdef0123456789abcdef01234567";

describe("withEsmShIteratePackage", () => {
  it("removes only Iterate's direct URL and adds the internal esbuild plugin", () => {
    const options = {
      bundle: true,
      files: {
        "package.json": JSON.stringify({
          dependencies: { iterate: PACKAGE_SPEC, react: "19.2.4" },
          devDependencies: { iterate: PACKAGE_SPEC, typescript: "5.9.3" },
          private: true,
        }),
        "src/client.ts": "source",
      },
    };

    const prepared = withEsmShIteratePackage(options);

    expect(prepared).not.toBe(options);
    expect(JSON.parse(prepared.files["package.json"]!)).toEqual({
      dependencies: { react: "19.2.4" },
      devDependencies: { typescript: "5.9.3" },
      private: true,
    });
    expect(JSON.parse(options.files["package.json"])).toMatchObject({
      dependencies: { iterate: PACKAGE_SPEC },
    });
    expect(prepared.__dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired).toHaveLength(1);
  });

  it("leaves transform-only and ordinary npm manifests to worker-bundler", () => {
    const transformOnly = {
      bundle: false,
      files: { "package.json": JSON.stringify({ devDependencies: { iterate: PACKAGE_SPEC } }) },
    };
    const registryPackage = {
      files: { "package.json": JSON.stringify({ dependencies: { iterate: "^0.3.0" } }) },
    };

    expect(withEsmShIteratePackage(transformOnly)).toBe(transformOnly);
    expect(withEsmShIteratePackage(registryPackage)).toBe(registryPackage);
  });

  it("rejects ambiguous or malformed pkg.pr.new refs", () => {
    expect(() =>
      withEsmShIteratePackage({
        files: {
          "package.json": JSON.stringify({
            dependencies: { iterate: `${PACKAGE_SPEC}-one` },
            devDependencies: { iterate: `${PACKAGE_SPEC}-two` },
          }),
        },
      }),
    ).toThrow(/different pkg\.pr\.new versions/);
    expect(() =>
      withEsmShIteratePackage({
        files: {
          "package.json": JSON.stringify({
            dependencies: { iterate: `${PACKAGE_SPEC}/../../other` },
          }),
        },
      }),
    ).toThrow(/Unsupported Iterate pkg\.pr\.new ref/);
  });
});

describe("createEsmShIteratePlugin", () => {
  it("bundles and tree-shakes separate browser and Worker graphs with no remote imports", async () => {
    const modules = new Map([
      [
        `${ESM_SH_ROOT}/live-state?bundle=false&target=es2022`,
        'export { chosen, unused } from "/pr/iterate/iterate/iterate@0123456789abcdef0123456789abcdef01234567/es2022/live-state.nobundle.mjs";',
      ],
      [
        `${ESM_SH_ROOT}/es2022/live-state.nobundle.mjs`,
        'export function chosen() { return "client-kept"; } export function unused() { return "client-dropped"; }',
      ],
      [
        `${ESM_SH_ROOT}/sdk?bundle=false&target=es2022`,
        'export { chosen, unused } from "/pr/iterate/iterate/iterate@0123456789abcdef0123456789abcdef01234567/es2022/sdk.nobundle.mjs";',
      ],
      [
        `${ESM_SH_ROOT}/es2022/sdk.nobundle.mjs`,
        'import { WorkerEntrypoint } from "/cloudflare:workers?target=es2022"; export function chosen() { return WorkerEntrypoint.name + "-server-kept"; } export function unused() { return "server-dropped"; }',
      ],
    ]);
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const source = modules.get(url);
      if (source === undefined) return new Response("missing", { status: 404 });
      return new Response(source, {
        headers: { "content-type": "application/javascript" },
      });
    });
    const plugin = createEsmShIteratePlugin(ESM_SH_ROOT, { fetcher });

    const client = await bundle(
      'import { chosen } from "iterate/live-state"; document.body.textContent = chosen();',
      plugin,
    );
    const server = await bundle(
      'import { chosen } from "iterate/sdk"; export default { fetch() { return new Response(chosen()); } };',
      plugin,
    );

    expect(client).toContain("client-kept");
    expect(client).not.toContain("client-dropped");
    expect(server).toContain("server-kept");
    expect(server).not.toContain("server-dropped");
    expect(server).toContain('from "cloudflare:workers"');
    for (const output of [client, server]) {
      expect(output).not.toMatch(
        /(?:from\s*|import\s*\()\s*["'](?:https:\/\/esm\.sh|\/pr\/iterate\/iterate)/,
      );
    }
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("bounds remote module count and response size", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response("export const value = 'this response is too large';", {
          headers: { "content-type": "application/javascript" },
        }),
    );
    const plugin = createEsmShIteratePlugin(ESM_SH_ROOT, {
      fetcher,
      maxModuleBytes: 8,
      maxModules: 1,
    });

    await expect(bundle('import "iterate/sdk";', plugin)).rejects.toThrow(/exceeds 8 bytes/);
  });
});

async function bundle(source: string, plugin: ReturnType<typeof createEsmShIteratePlugin>) {
  const result = await build({
    bundle: true,
    format: "esm",
    logLevel: "silent",
    platform: "browser",
    plugins: [plugin],
    stdin: { contents: source, loader: "ts", resolveDir: ".", sourcefile: "entry.ts" },
    target: "es2022",
    write: false,
  });
  return result.outputFiles[0]!.text;
}
