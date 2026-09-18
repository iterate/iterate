// Additional recreation proof: agent smoke does not boot any sandbox container.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connectItx } from "iterate/node";
import { cloudflareWorkerVersionOverrideHeaders } from "../../packages/shared/src/test-support/cloudflare-worker-version-overrides.ts";

const startedAt = Date.now();
console.log(JSON.stringify({ phase: "start", at: startedAt }));
using session = connectItx({
  baseUrl: process.env.EXPERIMENT_ORIGIN!,
  headers: cloudflareWorkerVersionOverrideHeaders(process.env),
});
using root = session.authenticate({
  type: "admin-secret",
  secret: process.env.APP_CONFIG_ADMIN_API_SECRET!,
});
using project = await root.projects.get(`lease-container-${randomUUID().slice(0, 8)}`).create({});
console.log(JSON.stringify({ phase: "project-created", elapsedMs: Date.now() - startedAt }));
const path = "/sandboxes/recreation";
await project.sandboxes.get(path).create({ instanceType: "lite" });
console.log(JSON.stringify({ phase: "sandbox-created", elapsedMs: Date.now() - startedAt }));
// The public sandbox handle forwards SDK methods dynamically; its facade type omits exec.
const sandbox: any = await project.sandboxes.get(path);
try {
  const result = await sandbox.exec("printf lease-cycling-ok", { timeout: 30_000 });
  console.log(
    JSON.stringify({ phase: "container-exec", elapsedMs: Date.now() - startedAt, result }),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "lease-cycling-ok");
} finally {
  await sandbox.destroy();
  console.log(JSON.stringify({ phase: "container-destroyed", elapsedMs: Date.now() - startedAt }));
}
