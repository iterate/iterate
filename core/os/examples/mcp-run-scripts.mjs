// examples/mcp-run-scripts.mjs — scripts for the MCP server's one tool, `run({ project?, script })`,
// beyond the ones its instructions show (src/mcp.ts). Each export is an `async (itx) => …` function:
// send its source as `script`. It runs with the project's root `itx` handle at `/`, as whoever the MCP
// connection signed in; nothing here sets up authentication or a project. Pinned by
// test/vitest/os/mcp-project-root.e2e.test.ts, which runs every one through MCP in a fresh project.

/** The config repo's files: the project's site and its configuration. */
export const listConfigFiles = async (itx) => itx.repos.get("/repos/config").listFiles();

/** The config's package.json: its `main` names the module the site runs. */
export const readPackageJson = async (itx) =>
  itx.repos.get("/repos/config").readFile("package.json");

/** Another context of the project, by path, and the project's key-value store. */
export const appendNoteAndRemember = async (itx) => {
  await itx.cd("/notes/mcp").append({ type: "note", payload: { ok: true } });
  await itx.kv.put("mcp", "root");
  return itx.kv.get("mcp");
};

/**
 * A site of two modules in one commit, published: every config-repo commit gets one outcome event
 * on the root, `worker-updated` once the site serves it, or `worker-update-failed` with the reason.
 */
export const publishSite = async (itx) => {
  const repo = itx.repos.get("/repos/config");
  const tip = await repo.tip();
  const { commitOid } = await repo.commitFiles({
    message: "Serve the page from a module of its own\n\nVia: Claude Code",
    parent: tip,
    changes: [
      { path: "app/page.js", content: 'export const html = "<h1>Published over MCP</h1>";' },
      {
        path: "worker.ts",
        content: [
          'import { IterateConfigEntrypoint } from "iterate/sdk";',
          'import { html } from "./app/page.js";',
          "export default class extends IterateConfigEntrypoint {",
          '  fetch() { return new Response(html, { headers: { "content-type": "text/html" } }); }',
          "}",
          "",
        ].join("\n"),
      },
    ],
  });
  const outcome = await itx.waitForEvent({
    type: [
      "events.iterate.com/project/worker-updated",
      "events.iterate.com/project/worker-update-failed",
    ],
    payload: { commitOid },
    afterOffset: 0,
    timeoutMs: 120000,
  });
  if (outcome.type.endsWith("worker-update-failed")) throw new Error(outcome.payload.error);
  const { projectUrl } = await itx.whoami();
  return { ...outcome.payload, projectUrl };
};
