import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createAdaptorServer } from "@hono/node-server";
import { daemonServiceManifest } from "@iterate-com/daemon-contract";
import { baseApp, injectWebSocket } from "./utils/hono.ts";
import { ptyRouter } from "./routers/pty.ts";

const env = daemonServiceManifest.envVars.parse(process.env);

baseApp.get("/healthz", (c) => c.text("ok"));
baseApp.route("/api/pty", ptyRouter);

function ensureModuleSource(code: string): string {
  if (code.includes("export default")) return code;
  return `export default async () => {\n${code}\n};\n`;
}

baseApp.post("/api/tools/exec-ts", async (c) => {
  const body = (await c.req.json()) as { code?: string };
  const code = body.code;
  if (!code || code.trim().length === 0) {
    return c.json({ error: "code is required" }, 400);
  }

  const dir = join(tmpdir(), "jonasland-daemon-exec");
  await mkdir(dir, { recursive: true });
  const scriptPath = join(dir, `script-${randomUUID()}.mjs`);

  try {
    await writeFile(scriptPath, ensureModuleSource(code), "utf8");
    const mod = (await import(`${pathToFileURL(scriptPath).href}?v=${Date.now()}`)) as {
      default?: () => Promise<unknown>;
    };
    if (typeof mod.default !== "function") {
      return c.json({ error: "code must export default async function" }, 400);
    }

    const result = await mod.default();
    return c.json({ ok: true as const, result });
  } finally {
    await rm(scriptPath, { force: true }).catch(() => {});
  }
});

export const startDaemonService = async () => {
  const server = createAdaptorServer({ fetch: baseApp.fetch });
  injectWebSocket(server);

  await new Promise<void>((resolve) => {
    server.listen(env.DAEMON_SERVICE_PORT, "0.0.0.0", () => resolve());
  });

  return {
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
};

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  void startDaemonService();
}
