import { expect, test } from "vitest";
import {
  generateProjectApiKeyMaterial,
  PROJECT_API_KEY_SECRET_PATH,
} from "../../src/domains/secrets/utils.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

// Ingress half of "externally deployed userspace apps": an app anywhere on
// the internet authenticates to /api AS its project with the `project-secret`
// credential, verified against the write-only secret every project is born
// with at /secrets/project-api-key. The comparison happens inside the Secret
// Durable Object; the pairing ceremony is the owner WRITING a value they
// hold (material is write-only, so nothing ever reads it back).
//
// Outbound remote apps ride the config-worker reverse proxy instead of a
// platform-side Cap'n Web mount — see docs/remote-apps.md.

test("an external client authenticates with the project-secret credential and gets exactly its project", async () => {
  using session = withItxSession();
  using admin = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = admin.projects.create({
    slug: `remote-ingress-${crypto.randomUUID().slice(0, 8)}`,
  });
  const projectId = await project.projectId;
  using other = admin.projects.create({
    slug: `remote-ingress-other-${crypto.randomUUID().slice(0, 8)}`,
  });
  const otherProjectId = await other.projectId;

  // The pairing ceremony: the born ingress secret has visibility
  // "readable" (an immutable birth-certificate fact), so the operator just
  // reveal()s it — as often as
  // they like — and configures their external app with it. The ensure-create
  // only covers the race with the birth seed (create() is idempotent: an
  // already-created secret returns its birth event untouched).
  const secret = project.secrets.get(PROJECT_API_KEY_SECRET_PATH);
  await secret
    .create({
      egress: { urls: [] },
      material: generateProjectApiKeyMaterial(),
      visibility: "readable",
    })
    .catch(() => undefined);
  const apiKey = (await secret.reveal()) as string;
  expect(apiKey).toMatch(/^itxk_/);
  // Display-more-than-once is the point: a second reveal answers the same.
  expect(await secret.reveal()).toBe(apiKey);

  // The external app's whole connection recipe: dial /api, present the
  // project-scoped credential, use the project.
  using externalSession = withItxSession();
  using externalProject = externalSession
    .authenticate({ type: "project-secret", projectId, secret: apiKey })
    .projects.get(projectId);
  expect(await externalProject.projectId).toBe(projectId);

  // Confinement: the same credential reaches NOTHING else. (Async closures:
  // a bare expect(stub).rejects can vacuously pass — see capnweb notes.)
  using externalSession2 = withItxSession();
  using scoped = externalSession2.authenticate({
    type: "project-secret",
    projectId,
    secret: apiKey,
  });
  await expect(async () => {
    using leaked = scoped.projects.get(otherProjectId);
    await leaked.projectId;
  }).rejects.toThrow(/no access|not found/i);

  // The readable key's "never substituted outbound" property is an
  // INVARIANT, not a default: attaching egress origins later is rejected.
  await expect(async () => {
    await secret.update({ egress: { urls: ["https://exfiltrate.example"] } });
  }).rejects.toThrow(/cannot have egress origins/);

  // Write-only secrets stay write-only: reveal() on an ordinary secret
  // (born with the default visibility) refuses.
  await project.secrets
    .get("/secrets/write-only-probe")
    .create({ egress: { urls: [] }, material: "sealed" });
  await expect(async () => {
    await project.secrets.get("/secrets/write-only-probe").reveal();
  }).rejects.toThrow(/write-only/);

  // A wrong value is rejected at the door.
  using rejectedSession = withItxSession();
  await expect(async () => {
    using denied = rejectedSession.authenticate({
      type: "project-secret",
      projectId,
      secret: "itxk_wrong",
    });
    using deniedProject = denied.projects.get(projectId);
    await deniedProject.projectId;
  }).rejects.toThrow(/missing or invalid auth/i);
});
