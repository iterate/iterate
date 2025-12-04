import { join } from "path";
import { mkdir, readFile, access, appendFile, stat } from "fs/promises";
import { stripVTControlCharacters } from "util";
import { createInterface } from "readline/promises";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { type Result, x } from "tinyexec";
import { streamSSE } from "hono/streaming";
import { logger } from "hono/logger";
import TailFile from "@logdna/tail-file";

const app = new Hono();
app.use(logger());

const runningBuilds = new Map<string, Promise<void>>();

const withLogs = async (process: Result, logger: (log: Log) => Promise<void>) => {
  for await (const line of process) {
    await logger({
      event: "stdout",
      data: stripVTControlCharacters(line),
    });
  }
  if (process.exitCode !== 0) {
    await logger({
      event: "stdout",
      data: `Process exited with code ${process.exitCode}`,
    });
  }
  return process;
};

type BuildConfigInput = {
  repo: string;
  branch: string;
  path?: string;
  buildId: string;
  authToken?: string;
};

type Log = {
  event: "info" | "stdout" | "files" | "output" | "error" | "complete";
  data: string;
};

async function buildConfig(options: BuildConfigInput) {
  const { repo, branch, path, authToken, buildId } = options;
  const targetDir = join(process.cwd(), "builds", buildId);
  const logFilePath = join(process.cwd(), "logs", `${buildId}.jsonl`);
  console.log(`Writing logs to ${logFilePath}`);

  const log = async (log: Log) => {
    console.log(JSON.stringify(log));
    await appendFile(logFilePath, JSON.stringify(log) + "\n");
    await new Promise((resolve) => setTimeout(resolve, 500));
  };
  await mkdir(targetDir, { recursive: true });

  try {
    // Mask auth token for logging
    if (options.authToken)
      options.authToken = options.authToken.slice(0, 4) + "*".repeat(options.authToken.length - 4);
    await log({
      event: "info",
      data: `Build started with config: ${JSON.stringify(options)}`,
    });

    if (authToken) {
      await log({
        event: "info",
        data: `Using auth token to login to GitHub`,
      });

      const res = await x("sh", ["-c", `echo "${authToken}" | gh auth login --with-token`], {
        nodeOptions: {
          env: process.env,
        },
      });
      if (res.exitCode !== 0) {
        await log({
          event: "error",
          data: `Failed to login to GitHub: ${res.stderr}`,
        });
        return;
      }
      await log({
        event: "info",
        data: `Logged in to GitHub`,
      });
      await x("gh", ["auth", "setup-git"], {
        nodeOptions: {
          env: process.env,
        },
      });
    }

    await log({
      event: "info",
      data: `Cloning repository ${repo}`,
    });

    const clone = await withLogs(
      x("git", ["clone", repo, "--depth", "1", "--single-branch", "--branch", branch, targetDir], {
        nodeOptions: {
          env: process.env,
        },
      }),
      log,
    );
    if (clone.exitCode !== 0) return;

    await log({
      event: "info",
      data: `Installing dependencies at ${targetDir}`,
    });

    const installTargetDir = path ? join(targetDir, path) : targetDir;
    const install = await withLogs(
      x("pnpm", ["install"], {
        nodeOptions: {
          cwd: installTargetDir,
          env: process.env,
        },
      }),
      log,
    );
    if (install.exitCode !== 0) return;

    await log({
      event: "info",
      data: `Evaluating target config`,
    });

    const config = await x("pnpm", ["iterate"], {
      nodeOptions: {
        cwd: installTargetDir,
        env: process.env,
      },
    });

    if (config.exitCode !== 0) {
      await log({
        event: "error",
        data: `Failed to evaluate target config: ${config.stderr}`,
      });
      return;
    }

    const gitLsFiles = await x("git", ["ls-files", installTargetDir], {
      nodeOptions: {
        cwd: installTargetDir,
        env: process.env,
      },
    });

    const files = await Promise.all(
      gitLsFiles.stdout.split("\n").map(async (file) => {
        const statResult = await stat(join(installTargetDir, file));
        if (!statResult.isFile()) return [];
        const content = await readFile(join(installTargetDir, file), "utf8");
        return [{ path: file, content }];
      }),
    ).then((files) => files.flat());

    await log({
      event: "files",
      data: JSON.stringify(files, null, 2),
    });

    await log({
      event: "output",
      data: config.stdout,
    });

    await log({
      event: "complete",
      data: "Build completed successfully",
    });
  } catch (error) {
    await log({
      event: "error",
      data: String(error),
    });
  }
}

app.get("/", (c) => c.json({ message: "🏝️ Ready!" }));
app.post(
  "/trigger-build",
  zValidator(
    "json",
    z.object({
      buildId: z.string(),
      repo: z.string(),
      branch: z.string(),
      path: z.string().optional(),
      authToken: z.string().optional(),
    }),
  ),
  async (c) => {
    const { buildId, repo, branch, path, authToken } = c.req.valid("json");
    await mkdir(join(process.cwd(), "logs"), { recursive: true });
    const logFile = join(process.cwd(), "logs", `${buildId}.jsonl`);
    const isBuilding = await access(logFile)
      .then(() => true)
      .catch(() => false);

    if (isBuilding || runningBuilds.has(buildId))
      return c.json({
        error: "Build is already triggered, use `/logs` to get the logs",
      });

    // Run build in background
    const buildPromise = buildConfig({ buildId, repo, branch, path, authToken });
    runningBuilds.set(buildId, buildPromise);
    buildPromise.finally(() => runningBuilds.delete(buildId));
    return c.json({ message: "Build triggered successfully, use `/logs` to get the logs" });
  },
);

app.get("/wait-for-build", zValidator("query", z.object({ buildId: z.string() })), async (c) => {
  const { buildId } = c.req.valid("query");
  if (runningBuilds.has(buildId)) {
    return streamSSE(c, async (api) => {
      const { promise, resolve } = Promise.withResolvers();

      const timer = setInterval(() => {
        api.writeSSE({ event: "ping", data: "ping" });
      }, 1000);

      runningBuilds
        .get(buildId)
        ?.then((result) => {
          resolve(result);
        })
        ?.finally(() => {
          clearInterval(timer);
        });

      await promise;
    });
  } else {
    return c.json({ error: "Build not found" }, 404);
  }
});

const tryParseLogLine = (line: string): Log | null => {
  if (line.trim() === "") return null;
  try {
    return JSON.parse(line);
  } catch {
    console.error(`Failed to parse log line: ${line}`);
    return null;
  }
};

app.get(
  "/logs",
  zValidator(
    "query",
    z.object({ buildId: z.string(), type: z.enum(["json", "sse"]).default("json") }),
  ),
  async (c) => {
    const { buildId, type } = c.req.valid("query");
    const logFile = join(process.cwd(), "logs", `${buildId}.jsonl`);

    if (
      !(await access(logFile)
        .then(() => true)
        .catch(() => false))
    ) {
      return c.json({ error: "Build logs not found, build may not have started yet" }, 404);
    }

    if (type === "sse") {
      return streamSSE(c, async (api) => {
        const file = new TailFile(logFile, { startPos: 0 });
        const rl = createInterface({ input: file });
        await file.start();
        const { promise, resolve, reject } = Promise.withResolvers();

        rl.on("line", async (line) => {
          const log = tryParseLogLine(line);
          if (!log) return;
          await api.writeSSE({ event: log.event, data: log.data });
          // Close SSE stream when build is complete or failed
          if (log.event === "complete" || log.event === "error") {
            await api.close();
            rl.close();
            resolve(null);
          }
        });

        file.on("error", async (error) => {
          console.error(`Error reading log file`, error);
          await api.writeSSE({ event: "error", data: String(error) });
          await api.close();
          rl.close();
          reject(error);
        });
        await promise;
      });
    } else {
      const logs = await readFile(join(process.cwd(), "logs", `${buildId}.jsonl`), "utf-8").then(
        (file) =>
          file
            .split("\n")
            .map(tryParseLogLine)
            .filter((log) => log !== null),
      );
      return c.json({ buildId, logs });
    }
  },
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

  // Give the server 5 seconds to close gracefully
  setTimeout(() => {
    process.exit(0);
  }, 5000);

  server.close(() => {
    console.log(`Server closed`);
    process.exit(0);
  });
};

process.on("SIGINT", exitHandler);
process.on("SIGTERM", exitHandler);
