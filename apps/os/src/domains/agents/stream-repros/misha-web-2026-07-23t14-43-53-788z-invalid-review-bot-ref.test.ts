import { createWorker } from "@cloudflare/worker-bundler";
import { GithubAiLinter } from "iterate/starter-apps/github-ai-linter";
import type { StreamEvent, StreamEventInput } from "iterate/sdk";
import { expect, test } from "vitest";
import { DynamicWorkerRef } from "../../workers/schemas.ts";
import fixture from "./misha-web-2026-07-23t14-43-53-788z-invalid-review-bot-ref.fixture.json";

test("re-linking the packaged linter replaces Misha's rejected subscription with a valid worker ref", async () => {
  const appended: Array<{ events: StreamEventInput[]; path: string }> = [];
  const app = GithubAiLinter.create(
    projectEnv((path, ...events) => appended.push({ events, path })),
    {
      policyVersion: "1",
      rules: { glob: "rules/**/*.md", repoPath: "/repos/iterate" },
    },
  );

  await app.processEvent(githubLinkConfigured(fixture.connection));

  const subscription: any = appended[0]?.events[0];
  const ref = subscription.payload.receiver.expression[1][1];
  expect({
    idempotencyKeyChanged:
      subscription.idempotencyKey !== fixture.existingSubscription.idempotencyKey,
    workerRef: DynamicWorkerRef.safeParse(ref),
  }).toMatchObject({
    idempotencyKeyChanged: true,
    workerRef: { success: true },
  });
});

test("worker-bundler accepts the packaged linter's installed entry point", async () => {
  const appended: Array<{ events: StreamEventInput[]; path: string }> = [];
  const app = GithubAiLinter.create(
    projectEnv((path, ...events) => appended.push({ events, path })),
    {
      policyVersion: "misha-smoke-1",
      rules: { glob: "rules/**/*.md", repoPath: "/repos/config" },
    },
  );

  await app.processEvent(githubLinkConfigured(fixture.connection));

  const subscription: any = appended[0]?.events[0];
  const ref = subscription.payload.receiver.expression[1][1];
  const createWorkerOptions = ref.source.createWorker;
  const installedEntrypoint =
    "node_modules/iterate/dist/starter-apps/github-ai-linter/configured-worker.mjs";
  const result = await createWorker({
    ...createWorkerOptions,
    // Node can exercise worker-bundler's dependency-install and entry-point
    // contract, but the real bundle requires its workerd-only WebAssembly
    // loader. The production smoke exercises that final stage.
    bundle: false,
    files: {
      "package.json": "{}",
      [installedEntrypoint]: [
        'import config from "iterate:github-ai-linter-config";',
        "export default {",
        "  fetch() {",
        "    return new Response(config.policyVersion);",
        "  },",
        "};",
      ].join("\n"),
    },
  });

  expect({
    mainModule: result.mainModule,
    moduleSource: result.modules[result.mainModule],
  }).toMatchObject({
    mainModule: installedEntrypoint,
    moduleSource: expect.stringContaining('from "iterate:github-ai-linter-config"'),
  });
});

function githubLinkConfigured(connection: string): StreamEvent {
  return {
    createdAt: "2026-07-23T14:49:58.078Z",
    offset: 42,
    path: "/",
    payload: { connection },
    type: "events.iterate.com/repo/github-link-configured",
  };
}

function projectEnv(append: (path: string, ...events: StreamEventInput[]) => void): any {
  return {
    ITX: {
      get: async () => ({
        [Symbol.dispose]() {},
        streams: {
          get: (path: string) => ({
            append: async (...events: StreamEventInput[]) => append(path, ...events),
          }),
        },
      }),
    },
  };
}
