import { createServer } from "node:http";
import { once } from "node:events";
import { expect, test } from "vitest";
import { CiStatus } from "./status.ts";

test("a milestone releases a waiter while its exact producer is still running", async () => {
  const statuses: any[] = [];
  await using server = await serveJson(async (request, body) => {
    if (request.url.includes("GetWorkflow")) return workflow();
    if (request.method === "POST") {
      statuses.unshift(body);
      return body;
    }
    return { statuses };
  });
  const producer = new CiStatus(options(server.url, "prepare"));
  const consumer = new CiStatus(options(server.url, "apps"));
  await producer.set("preview-ready");
  await expect(consumer.waitFor("prepare", "preview-ready")).resolves.toMatchObject({
    producer: "prepare",
    attemptId: "prepare-attempt",
  });
  expect(statuses).toMatchObject([
    {
      context: "ci/wf/execution/prepare/prepare-attempt/preview-ready",
      state: "success",
    },
  ]);
});

test.each(["finished", "failed", "cancelled", "skipped"])(
  "a %s producer without its signal fails promptly",
  async (state) => {
    await using server = await serveJson(async (request) => {
      if (!request.url.includes("GetWorkflow"))
        return {
          statuses: [
            { context: "ci/old/execution/prepare/old-attempt/preview-ready", state: "success" },
          ],
        };
      const data = workflow();
      data.jobs[0].status = state;
      return data;
    });
    await expect(
      new CiStatus(options(server.url, "apps")).waitFor("prepare", "preview-ready"),
    ).rejects.toThrow(`Producer prepare ${state} without preview-ready`);
  },
);

test("a producer retry is rejected instead of consuming its predecessor's signal", async () => {
  await using server = await serveJson(async () => {
    const data = workflow();
    data.jobs[0].attempts.push({ attemptId: "new-attempt", attempt: 2, status: "running" });
    return data;
  });
  await expect(
    new CiStatus(options(server.url, "apps")).waitFor("prepare", "preview-ready"),
  ).rejects.toThrow("fresh workflow run");
});

test("cleanup waits for the running consumer even when another consumer failed", async () => {
  let reads = 0;
  await using server = await serveJson(async () => {
    const data = workflow();
    data.jobs[1].status = "failed";
    data.jobs[2].status = ++reads < 3 ? "running" : "finished";
    return data;
  });
  const status = new CiStatus(options(server.url, "finish"));
  await expect(status.waitForJobs(["apps", "playwright:matrix-0"])).resolves.toMatchObject({
    settled: true,
    succeeded: false,
    jobs: [{ status: "failed" }, { status: "finished" }],
  });
  expect(reads).toBe(3);
});

test("a live producer that never signals has a bounded wait", async () => {
  await using server = await serveJson(async (request) =>
    request.url.includes("GetWorkflow") ? workflow() : { statuses: [] },
  );
  const status = new CiStatus({ ...options(server.url, "apps"), timeoutMs: 50 });
  await expect(status.waitFor("prepare", "preview-ready")).rejects.toThrow();
});

test("a final milestone is accepted even after the producer terminates", async () => {
  const statuses: any[] = [];
  await using server = await serveJson(async (request, body) => {
    if (request.url.includes("GetWorkflow")) {
      const data = workflow();
      if (statuses.length) data.jobs[0].status = "failed";
      return data;
    }
    if (request.method === "POST") {
      statuses.push(body);
      return body;
    }
    return { statuses };
  });
  await new CiStatus(options(server.url, "prepare")).set("preview-ready");
  await expect(
    new CiStatus(options(server.url, "apps")).waitFor("prepare", "preview-ready"),
  ).resolves.toMatchObject({ producer: "prepare" });
});

test("foreign commits cannot release consumers and a missing consumer cannot authorize cleanup", async () => {
  await using server = await serveJson(async () => workflow());
  await expect(
    new CiStatus({ ...options(server.url, "apps"), sha: "other-head" }).waitFor(
      "prepare",
      "preview-ready",
    ),
  ).rejects.toThrow("does not match");
  await expect(
    new CiStatus(options(server.url, "finish")).waitForJobs(["missing-shard"]),
  ).rejects.toThrow("Expected exactly one consumer");
});

async function serveJson(handler: (request: any, body: any) => Promise<any>) {
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(await handler(request, body)));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as any;
  return {
    url: `http://127.0.0.1:${address.port}`,
    [Symbol.asyncDispose]: () => server[Symbol.asyncDispose](),
  };
}

function workflow() {
  return {
    workflowId: "wf",
    repo: "iterate/iterate",
    headSha: "head",
    executions: [{ executionId: "execution", execution: 1 }],
    jobs: ["prepare", "apps", "playwright:matrix-0", "finish"].map((key) => ({
      jobId: key,
      jobKey: `cloudflare-previews.yml:preview:${key}`,
      status: "running",
      attempts: [{ attemptId: `${key}-attempt`, attempt: 1, status: "running" }],
    })),
  };
}

function options(url: string, job: string) {
  return {
    depotApi: url,
    githubApi: url,
    depotToken: "depot-test-token",
    githubToken: "github-test-token",
    jobUrl: `https://depot.dev/orgs/org/workflows/wf?job=${job}&attempt=${job}-attempt`,
    repository: "iterate/iterate",
    sha: "head",
    pollMs: 1,
    timeoutMs: 1_000,
  };
}
