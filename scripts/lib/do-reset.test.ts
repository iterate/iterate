import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { temporaryDirectory } from "@iterate-com/shared/test-support/temporary-directory";
import { expect, test, vi } from "vitest";
import { resetWorkerDurableObjects } from "./do-reset.ts";

test.for([
  {
    name: "retires every class the worker owns, and no other worker's",
    workerName: "os-prd",
    workers: ["os-prd", "dash-prd"],
    namespaces: [
      { id: "project", script: "os-prd", class: "ProjectDurableObject" },
      { id: "context", script: "os-prd", class: "IterateContextDurableObject" },
      { id: "session", script: "dash-prd", class: "BrowserSession" },
    ],
    exports: {
      IterateContextDurableObject: { type: "durable-object", state: "deleted" },
      ProjectDurableObject: { type: "durable-object", state: "deleted" },
    },
  },
  {
    name: "retires a preview parent's own classes, none of its Worker Previews' namespaces",
    workerName: "os",
    workers: ["os"],
    namespaces: [
      { id: "own", script: "os", class: "ProjectDurableObject" },
      { id: "pr7", script: "os", class: "ProjectDurableObject", preview: { name: "pr7" } },
      // a class only the pull request declares
      { id: "pr7-repo", script: "os", class: "RepoDurableObject", preview: { name: "pr7" } },
    ],
    exports: { ProjectDurableObject: { type: "durable-object", state: "deleted" } },
  },
  {
    name: "never deploys, and so never creates, a worker that does not exist",
    workerName: "os-prd",
    workers: ["dash-prd"],
    namespaces: [{ id: "project", script: "os-prd", class: "ProjectDurableObject" }],
    exports: undefined,
  },
])("$name", async ({ workerName, workers, namespaces, exports }) => {
  using wrangler = fakeWrangler();
  await resetWorkerDurableObjects({
    ctx: resetCtx(workers, namespaces),
    workerName,
    cwd: wrangler.dir,
    credentials: { CLOUDFLARE_API_TOKEN: "test-token", CLOUDFLARE_ACCOUNT_ID: "test-account" },
    compatibilityDate: "2026-09-01",
  });
  expect(wrangler.deployed()).toEqual(
    exports && {
      command: "exec wrangler deploy --config",
      credentials: "test-token test-account",
      config: {
        name: workerName,
        main: "worker.js",
        compatibility_date: "2026-09-01",
        workers_dev: false,
        preview_urls: true,
        exports,
      },
      worker: readFileSync(new URL("./parked-worker/worker.js", import.meta.url), "utf8"),
    },
  );
});

/** The Cloudflare API the reset reads: the account's workers and its Durable Object namespaces. */
function resetCtx(workers: string[], namespaces: unknown[]) {
  // `cf` is generic over its result; this fake answers the two listings the reset makes.
  return {
    cf: async (path: string) =>
      path === "/workers/scripts" ? workers.map((id) => ({ id })) : namespaces,
  } as never;
}

/** A `pnpm` on PATH that records the parked deploy instead of running wrangler: the command, the
 *  credentials it was handed, and the config and module it would upload. */
function fakeWrangler() {
  const directory = temporaryDirectory();
  const dir = directory.path;
  writeFileSync(
    join(dir, "pnpm"),
    [
      "#!/bin/sh",
      `cd '${dir}'`,
      'printf "%s" "$1 $2 $3 $4" > command',
      'printf "%s" "$CLOUDFLARE_API_TOKEN $CLOUDFLARE_ACCOUNT_ID" > credentials',
      'cp "$5" wrangler.json',
      'cp "$(dirname "$5")/worker.js" worker.js',
    ].join("\n"),
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", `${dir}:${process.env.PATH}`);
  const read = (file: string) => readFileSync(join(dir, file), "utf8");
  return {
    dir,
    deployed: () =>
      existsSync(join(dir, "command"))
        ? {
            command: read("command"),
            credentials: read("credentials"),
            config: JSON.parse(read("wrangler.json")),
            worker: read("worker.js"),
          }
        : undefined,
    [Symbol.dispose]: directory[Symbol.dispose],
  };
}
