import { join } from "path";
import { mkdtemp } from "fs/promises";
import { stripVTControlCharacters } from "util";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { Result, x } from "tinyexec";
import { SSEStreamingApi, streamSSE } from "hono/streaming";
import { logger } from "hono/logger";

const app = new Hono();
app.use(logger());

const streamOutput = async (api: SSEStreamingApi, process: Result) => {
  for await (const line of process) {
    await api.writeSSE({
      event: "stdout",
      data: stripVTControlCharacters(line),
    });
  }
  if (process.exitCode !== 0) {
    await api.writeSSE({
      event: "error",
      data: `Process exited with code ${process.exitCode}`,
    });
  }
  return process;
};

app.get("/", (c) => c.json({ message: "🏝️ Ready!" }));
app.post(
  "/run-config",
  zValidator(
    "json",
    z.object({
      repo: z.string(),
      branch: z.string(),
      path: z.string().optional(),
      authToken: z.string().optional(),
    }),
  ),
  async (c) =>
    streamSSE(c, async (api) => {
      const { repo, branch, path, authToken } = c.req.valid("json");

      if (authToken) {
        await api.writeSSE({
          event: "info",
          data: `Using auth token to login to GitHub`,
        });
        const res = await x("gh", ["auth", "login", "--with-token", authToken], {
          nodeOptions: {
            env: process.env,
          },
        });
        if (res.exitCode !== 0) {
          await api.writeSSE({
            event: "error",
            data: `Failed to login to GitHub: ${res.stderr}`,
          });
          return api.close();
        }
        await api.writeSSE({
          event: "info",
          data: `Logged in to GitHub`,
        });
        await x("gh", ["auth", "setup-git"], {
          nodeOptions: {
            env: process.env,
          },
        });
      }

      await api.writeSSE({
        event: "info",
        data: `Cloning repository ${repo}`,
      });

      const targetDir = await mkdtemp("target-config-");

      const clone = await streamOutput(
        api,
        x(
          "git",
          ["clone", repo, "--depth", "1", "--single-branch", "--branch", branch, targetDir],
          {
            nodeOptions: {
              env: process.env,
            },
          },
        ),
      );

      if (clone.exitCode !== 0) return api.close();

      const cwd = path ? join(targetDir, path) : targetDir;

      await api.writeSSE({
        event: "info",
        data: `Installing dependencies at ${cwd}`,
      });

      const install = await streamOutput(
        api,
        x("pnpm", ["install"], {
          nodeOptions: {
            cwd,
            env: process.env,
          },
        }),
      );

      if (install.exitCode !== 0) return api.close();

      await api.writeSSE({
        event: "info",
        data: `Evaluating target config`,
      });

      const config = await x("pnpm", ["iterate"], {
        nodeOptions: {
          cwd,
          env: process.env,
        },
      });

      if (config.exitCode !== 0) {
        await api.writeSSE({
          event: "error",
          data: `Failed to execute target config: ${config.stderr}`,
        });
        return api.close();
      }

      await api.writeSSE({
        event: "output",
        data: config.stdout,
      });

      return api.close();
    }),
);

const server = serve(
  {
    fetch: app.fetch,
    port: 3000,
    hostname: "0.0.0.0",
  },
  (addr) => {
    console.log(`Server is running on ${addr.address}:${addr.port}`);
  },
);

const exitHandler = async (e: NodeJS.Signals) => {
  console.log(`Exiting with signal ${e}`);
  server.close(() => {
    console.log(`Server closed`);
  });
};

process.on("SIGINT", exitHandler);
process.on("SIGTERM", exitHandler);
