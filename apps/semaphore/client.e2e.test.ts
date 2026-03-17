import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import type { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createSemaphoreClient } from "@iterate-com/semaphore-contract";

function uniqueType() {
  return `e2e-type-${randomUUID().slice(0, 8)}`;
}

function onceLineMatches(
  child: ChildProcessByStdio<null, Readable, Readable>,
  pattern: RegExp,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";

    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const match = stdout.match(pattern);
      if (match?.[0]) {
        cleanup();
        resolve(match[0]);
      }
    };

    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    };

    const onExit = (code: number | null) => {
      cleanup();
      reject(
        new Error(
          `Alchemy dev exited before becoming ready (code=${code ?? "null"})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    };

    const interval = setInterval(() => {
      if (Date.now() - startedAt > timeoutMs) {
        cleanup();
        reject(
          new Error(
            `Timed out waiting for Alchemy dev URL\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
      }
    }, 200);

    const cleanup = () => {
      clearInterval(interval);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
    };

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("exit", onExit);
  });
}

async function waitForHealth(baseURL: string, timeoutMs: number) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(new URL("/health", baseURL));
      if (response.ok && (await response.text()) === "OK") {
        return;
      }
    } catch {
      // Keep polling until timeout.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for health at ${baseURL}`);
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopAlchemyDev(child: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }, 5_000);
  });
}

describe("semaphore worker e2e", () => {
  let child: ChildProcessByStdio<null, Readable, Readable>;
  let baseURL = "";
  let originalWranglerJson = "";

  const wranglerJsonPath = new URL("./wrangler.jsonc", import.meta.url).pathname;

  beforeAll(async () => {
    originalWranglerJson = await readFile(wranglerJsonPath, "utf8");

    const stage = `test-e2e-${randomUUID().slice(0, 8)}`;
    const workerName = `semaphore-${stage}`;

    child = spawn(
      "doppler",
      [
        "run",
        "--config",
        "dev",
        "--",
        "sh",
        "-c",
        `WORKER_NAME=${workerName} SEMAPHORE_API_TOKEN=test-token tsx ./alchemy.run.ts cli --dev --stage ${stage}`,
      ],
      {
        cwd: new URL(".", import.meta.url).pathname,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const rawUrl = await onceLineMatches(child, /http:\/\/localhost:\d+\/?/m, 120_000);
    baseURL = rawUrl.endsWith("/") ? rawUrl : `${rawUrl}/`;
    await waitForHealth(baseURL, 30_000);
  }, 120_000);

  afterAll(async () => {
    try {
      await stopAlchemyDev(child);
    } finally {
      await writeFile(wranglerJsonPath, originalWranglerJson, "utf8");
    }
  });

  test("baseURL client can add, list, acquire, and release resources against the live worker", async () => {
    const client = createSemaphoreClient({
      apiKey: "test-token",
      baseURL,
    });
    const type = uniqueType();

    const created = await client.resources.add({
      type,
      slug: "alpha",
      data: { token: "secret-alpha" },
    });
    expect(created.slug).toBe("alpha");

    const listed = await client.resources.list({ type });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.slug).toBe("alpha");
    expect(listed[0]?.leaseState).toBe("available");
    expect(listed[0]?.leasedUntil).toBeNull();

    const lease = await client.resources.acquire({
      type,
      leaseMs: 60_000,
    });
    expect(lease.slug).toBe("alpha");

    const leasedList = await client.resources.list({ type });
    expect(leasedList[0]?.leaseState).toBe("leased");
    expect(leasedList[0]?.leasedUntil).toEqual(expect.any(Number));

    const released = await client.resources.release({
      type,
      slug: lease.slug,
      leaseId: lease.leaseId,
    });
    expect(released).toEqual({ released: true });

    const releasedList = await client.resources.list({ type });
    expect(releasedList[0]?.leaseState).toBe("available");
    expect(releasedList[0]?.leasedUntil).toBeNull();
  });

  test("baseURL client can wait for a lease and receive it after release", async () => {
    const client = createSemaphoreClient({
      apiKey: "test-token",
      baseURL,
    });
    const type = uniqueType();

    await client.resources.add({
      type,
      slug: "only",
      data: { token: "secret-only" },
    });

    const firstLease = await client.resources.acquire({
      type,
      leaseMs: 60_000,
    });

    const waitingLeasePromise = client.resources.acquire({
      type,
      leaseMs: 60_000,
      waitMs: 2_000,
    });

    await sleep(250);

    const released = await client.resources.release({
      type,
      slug: firstLease.slug,
      leaseId: firstLease.leaseId,
    });
    expect(released).toEqual({ released: true });

    const waitingLease = await waitingLeasePromise;
    expect(waitingLease.slug).toBe("only");
  });

  test("client injects the bearer token and rejects invalid credentials", async () => {
    const badClient = createSemaphoreClient({
      apiKey: "wrong-token",
      baseURL,
    });

    const error = await badClient.resources.list({}).catch((caught) => caught);

    expect(error).toBeTruthy();
    expect(String(error)).toContain("Missing or invalid Authorization header");
  });
});
