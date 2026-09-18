import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createCli } from "trpc-cli";
import PreviewCoordination from "../preview/coordination.ts";
import CiStatus from "./status.ts";

test("a retried consumer can read a successful retained prerequisite", async () => {
  await using ci = await coordination();
  ci.workflow.jobs[1].attempts.push({ attemptId: "consumer-2", attempt: 2, status: "running" });
  ci.workflow.jobs[1].attempts[0].status = "failed";
  ci.statuses.push({
    context: "ready producer-1",
    state: "success",
    description: "slot=preview-2",
  });
  process.env.DEPOT_JOB_URL = ci.url("consumer", "consumer-2");
  const status = new CiStatus();
  await expect(status.waitFor("prepare", "ready")).resolves.toMatchObject({
    attemptId: "producer-1",
  });
  expect(await readFile(ci.env.GITHUB_OUTPUT, "utf8")).toContain("slot=preview-2\n");
});

test("a cross-workflow wait uses the requested commit and current producer attempt", async () => {
  await using ci = await coordination();
  ci.external = { ...ci.workflow, workflowId: "ancestor-run", headSha: "ancestor" };
  ci.external.jobs = [
    {
      ...ci.workflow.jobs[0],
      attempts: [
        { attemptId: "old", attempt: 1, status: "failed" },
        { attemptId: "new", attempt: 2, status: "finished" },
      ],
    },
  ];
  ci.statuses.push(
    { context: "ready old", state: "success", description: "slot=wrong" },
    { context: "ready new", state: "success", description: "slot=preview-3" },
  );
  const status = new CiStatus();
  await expect(
    status.waitFor("prepare", "ready", { workflowId: "ancestor-run", commit: "ancestor" }),
  ).resolves.toMatchObject({ attemptId: "new" });
  expect(ci.requests.some((request) => request.path.includes("/commits/ancestor/status"))).toBe(
    true,
  );
  expect(await readFile(ci.env.GITHUB_OUTPUT, "utf8")).toContain("slot=preview-3");
});

test("queued reruns cannot consume a finished attempt's old milestone", async () => {
  await using ci = await coordination();
  ci.workflow.jobs[0].status = "queued";
  ci.statuses.push({ context: "ready producer-1", state: "success", description: "slot=stale" });
  await expect(
    new CiStatus().waitFor("prepare", "ready", { timeoutSeconds: 0.05 }),
  ).rejects.toThrow();
  expect(ci.requests.some((request) => request.path.includes("/status"))).toBe(false);
});

test("a stopped producer without its milestone fails immediately", async () => {
  await using ci = await coordination();
  ci.workflow.jobs[0].status = "failed";
  await expect(new CiStatus().waitFor("prepare", "ready")).rejects.toThrow("failed without ready");
});

test("a wait follows a producer retried while its old signal was being read", async () => {
  await using ci = await coordination();
  ci.workflow.jobs[0].status = "failed";
  ci.statuses.push({ context: "ready producer-1", state: "success", description: "slot=old" });
  ci.onStatusRead = () => {
    ci.workflow.jobs[0].status = "finished";
    ci.workflow.jobs[0].attempts.push({ attemptId: "producer-2", attempt: 2, status: "finished" });
    ci.statuses.push({ context: "ready producer-2", state: "success", description: "slot=new" });
  };
  await expect(new CiStatus().waitFor("prepare", "ready")).resolves.toMatchObject({
    attemptId: "producer-2",
  });
  expect(await readFile(ci.env.GITHUB_OUTPUT, "utf8")).toBe("slot=new\n");
});

test("a cross-workflow wait rejects the wrong commit", async () => {
  await using ci = await coordination();
  ci.external = { ...ci.workflow, workflowId: "other", headSha: "wrong" };
  await expect(
    new CiStatus().waitFor("prepare", "ready", {
      workflowId: "other",
      commit: "expected",
    }),
  ).rejects.toThrow("does not match");
});

test("a superseded publisher cannot publish a milestone", async () => {
  await using ci = await coordination();
  ci.workflow.jobs[1].attempts.push({ attemptId: "consumer-2", attempt: 2, status: "running" });
  await expect(new CiStatus().set("ready")).rejects.toThrow("no longer active");
  expect(ci.requests.some((request) => request.path.includes("/statuses/"))).toBe(false);
});

test("the actual trpc-cli publishes a milestone", async () => {
  await using ci = await coordination();
  await expect(
    statusCli.run(
      {
        argv: ["set", "preview-settled", "--values", '{"tests":"success","deployment":"restored"}'],
        process: {
          exit(code) {
            throw Object.assign(new Error("CLI exited"), { exitCode: code });
          },
        },
      },
      statusProgram,
    ),
  ).rejects.toMatchObject({ exitCode: 0 });
  expect(ci.requests).toContainEqual({
    path: "/repos/iterate/iterate/statuses/head",
    body: expect.objectContaining({
      context: "preview-settled consumer-1",
      description: "tests=success; deployment=restored",
    }),
  });
});

test("the actual trpc-cli executes the preview retry guard", async () => {
  await using ci = await coordination();
  ci.workflow.jobs[1].attempts[0].startedAt = "2026-09-18T00:01:00Z";
  ci.workflow.jobs[0].attempts[0].startedAt = "2026-09-18T00:00:30Z";
  await expect(
    coordinationCli.run(
      {
        argv: ["verify", "0"],
        process: {
          exit(code) {
            throw Object.assign(new Error("CLI exited"), { exitCode: code });
          },
        },
      },
      coordinationProgram,
    ),
  ).rejects.toMatchObject({ exitCode: 0 });
  expect(await readFile(ci.env.GITHUB_ENV, "utf8")).toContain("PREVIEW_EXECUTION_ID=execution-1");
});

test("an active partial retry requests recovery before it can use old preparation", async () => {
  await using ci = await coordination();
  ci.workflow.workflowPath = "preview-main.yml";
  ci.workflow.jobs[0].attempts[0].startedAt = "2026-09-18T00:00:30Z";
  ci.workflow.jobs[1].attempts[0] = {
    attemptId: "consumer-1",
    attempt: 1,
    status: "failed",
    startedAt: "2026-09-18T00:01:00Z",
  };
  ci.workflow.jobs[1].attempts.push({
    attemptId: "consumer-2",
    attempt: 2,
    status: "running",
    startedAt: "2026-09-18T00:02:00Z",
  });
  process.env.DEPOT_JOB_URL = ci.url("consumer", "consumer-2");
  await expect(new PreviewCoordination().verify(0)).rejects.toThrow(
    "Requested a fresh full Preview run",
  );
  expect(ci.requests).toContainEqual({
    path: "/depot.ci.v1.CIService/DispatchWorkflow",
    body: expect.objectContaining({
      workflow: "preview-retry.yml",
      ref: "main",
      inputs: {
        "workflow-id": "workflow",
        "execution-id": "execution-1",
        "head-sha": "head",
        "pull-request-number": "0",
      },
    }),
  });
  await expect(readFile(ci.env.GITHUB_ENV, "utf8")).rejects.toThrow("ENOENT");
});

test("partial retry recovery requests are idempotent for an execution", async () => {
  await using ci = await coordination();
  ci.workflow.workflowPath = "preview-main.yml";
  ci.workflow.workflowStatus = "failed";
  ci.workflow.jobs[1].status = "failed";
  ci.workflow.jobs.push({
    jobId: "finish",
    jobKey: "preview-run.yml:finish",
    status: "finished",
    attempts: [],
  });
  await new PreviewCoordination().recover("workflow", "execution-1", "head", 0);
  await new PreviewCoordination().recover("workflow", "execution-1", "head", 0);
  expect(ci.requests.filter((request) => request.path.endsWith("/RerunWorkflow"))).toHaveLength(1);
});

test("recovery stops cancelling consumers when the workflow execution changes", async () => {
  await using ci = await coordination();
  ci.workflow.workflowPath = "preview-main.yml";
  ci.workflow.jobs.push(
    {
      jobId: "shard",
      jobKey: "preview-run.yml:playwright:matrix-0",
      status: "running",
      attempts: [],
    },
    { jobId: "finish", jobKey: "preview-run.yml:finish", status: "finished", attempts: [] },
  );
  ci.onRequest = (request) => {
    if (request.path.endsWith("/CancelJob")) {
      ci.workflow.executions.push({
        executionId: "new-execution",
        execution: 2,
        createdAt: "2026-09-18T01:00:00Z",
      });
      ci.workflow.workflowStatus = "queued";
    }
  };
  await expect(
    new PreviewCoordination().recover("workflow", "execution-1", "head", 0),
  ).resolves.toMatchObject({ recovered: false });
  expect(ci.requests.filter((request) => request.path.endsWith("/CancelJob"))).toHaveLength(1);
  expect(
    ci.requests.filter((request) => /\/(CancelWorkflow|RerunWorkflow)$/.test(request.path)),
  ).toHaveLength(0);
});

test("recovery validates its PR scope before cancelling anything", async () => {
  await using ci = await coordination();
  ci.workflow.workflowPath = "preview-main.yml";
  await expect(
    new PreviewCoordination().recover("workflow", "execution-1", "head", 7),
  ).rejects.toThrow("A PR number cannot target the main preview workflow");
  expect(ci.requests.filter((request) => /Cancel|Rerun/.test(request.path))).toHaveLength(0);
});

// Load the real command schemas once during collection, like static imports.
// Command execution stays inside each test and its disposable environment.
const statusCli = createCli({
  filename: new URL("./status.ts", import.meta.url),
  jsonInput: "auto",
});
const coordinationCli = createCli({
  filename: new URL("../preview/coordination.ts", import.meta.url),
  jsonInput: "auto",
});
const statusProgram = await statusCli.buildProgram();
const coordinationProgram = await coordinationCli.buildProgram();

async function coordination() {
  const directory = await mkdtemp(join(tmpdir(), "ci-coordination-"));
  const workflow: any = {
    workflowId: "workflow",
    repo: "iterate/iterate",
    headSha: "head",
    ref: "refs/heads/feature",
    workflowPath: ".depot/workflows/preview.yml",
    workflowStatus: "running",
    executions: [{ executionId: "execution-1", execution: 1, createdAt: "2026-09-18T00:00:00Z" }],
    jobs: [
      {
        jobId: "producer",
        jobKey: "preview-run.yml:prepare",
        status: "finished",
        attempts: [{ attemptId: "producer-1", attempt: 1, status: "finished" }],
      },
      {
        jobId: "consumer",
        jobKey: "preview-run.yml:apps",
        status: "running",
        attempts: [{ attemptId: "consumer-1", attempt: 1, status: "running" }],
      },
    ],
  };
  const statuses: any[] = [];
  const requests: any[] = [];
  const state = {
    external: null as any,
    onStatusRead: null as (() => void) | null,
    onRequest: null as ((request: any) => void) | null,
  };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    const body = text ? JSON.parse(text) : null;
    requests.push({ path: request.url, body });
    state.onRequest?.({ path: request.url, body });
    if (request.url?.endsWith("/RerunWorkflow")) {
      workflow.executions.push({
        executionId: "execution-2",
        execution: 2,
        createdAt: "2026-09-18T01:00:00Z",
      });
      workflow.workflowStatus = "queued";
    }
    if (request.url?.includes("/status?")) {
      state.onStatusRead?.();
      state.onStatusRead = null;
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        request.url?.includes("GetWorkflow")
          ? body.workflowId === "workflow"
            ? workflow
            : state.external
          : { statuses },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const url = (job: string, attempt: string) =>
    `https://depot.dev/orgs/org/workflows/workflow?job=${job}&attempt=${attempt}`;
  const previous = { ...process.env };
  const env = {
    DEPOT_CI_TELEMETRY_TOKEN: "test",
    GITHUB_TOKEN: "test",
    GITHUB_REPOSITORY: "iterate/iterate",
    CI_HEAD_SHA: "head",
    GITHUB_OUTPUT: join(directory, "outputs"),
    GITHUB_ENV: join(directory, "environment"),
    DEPOT_JOB_URL: url("consumer", "consumer-1"),
    GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
    DEPOT_API_URL: `http://127.0.0.1:${address.port}`,
  };
  Object.assign(process.env, env);
  return {
    workflow,
    statuses,
    requests,
    url,
    get external() {
      return state.external;
    },
    set external(value) {
      state.external = value;
    },
    env,
    set onRequest(callback: (request: any) => void) {
      state.onRequest = callback;
    },
    set onStatusRead(callback: () => void) {
      state.onStatusRead = callback;
    },
    async [Symbol.asyncDispose]() {
      for (const key of Object.keys(env)) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    },
  };
}
