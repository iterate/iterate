import { expect, test } from "vitest";
import { SignJWT } from "jose";
import {
  generateProjectApiKeyMaterial,
  PROJECT_API_KEY_SECRET_PATH,
} from "../../src/domains/secrets/utils.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

// Ingress lanes for "externally deployed userspace apps" (docs/remote-apps.md):
//
// - `project-secret` — the machine credential: a headless app authenticates
//   AS its project against the readable secret every project is born with at
//   /secrets/project-api-key (compared inside the Secret Durable Object; the
//   operator reveal()s the value and configures their app with it).
// - `project-app-session` — the user credential: a config-worker reverse
//   proxy forwards the browser's short-lived project-host token and the app
//   presents it to act as that user on that project.
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

// The user lane: sign a project-app-session token exactly as the auth worker
// does (HS256 under the shared secret this deployment verifies locally) and
// present it at /api the way a proxied remote app would.
test.skipIf(!process.env.APP_CONFIG_PROJECT_APP_SESSION_SECRET?.trim())(
  "a forwarded project-app-session token acts as its user on exactly its project",
  async () => {
    const sessionSecret = process.env.APP_CONFIG_PROJECT_APP_SESSION_SECRET!.trim();
    using session = withItxSession();
    using admin = session.authenticate({ type: "admin-secret", secret: adminSecret() });
    using project = admin.projects.create({
      slug: `remote-session-${crypto.randomUUID().slice(0, 8)}`,
    });
    const projectId = await project.projectId;
    using other = admin.projects.create({
      slug: `remote-session-other-${crypto.randomUUID().slice(0, 8)}`,
    });
    const otherProjectId = await other.projectId;

    const sign = (claims: Record<string, unknown>, expiresInSeconds = 900) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSeconds)
        .sign(new TextEncoder().encode(sessionSecret));
    const token = await sign({
      audience: "https://tasks--proxied.example",
      projectId,
      type: "project-app-session",
      userId: "usr_remote_e2e",
    });

    // The whole recipe a proxied app follows: present the forwarded token,
    // get exactly the user's project.
    using appSession = withItxSession();
    using asUser = appSession.authenticate({ type: "project-app-session", token });
    using userProject = asUser.projects.get(projectId);
    expect(await userProject.projectId).toBe(projectId);

    // Confinement: the token IS the scope — no other projects.
    using confinedSession = withItxSession();
    using confined = confinedSession.authenticate({ type: "project-app-session", token });
    await expect(async () => {
      using leaked = confined.projects.get(otherProjectId);
      await leaked.projectId;
    }).rejects.toThrow(/no access|not found/i);

    // An expired token and a garbage token are ordinary refusals.
    const expired = await sign(
      {
        audience: "https://tasks--proxied.example",
        projectId,
        type: "project-app-session",
        userId: "usr_remote_e2e",
      },
      -5,
    );
    using expiredSession = withItxSession();
    await expect(async () => {
      using denied = expiredSession.authenticate({ type: "project-app-session", token: expired });
      using deniedProject = denied.projects.get(projectId);
      await deniedProject.projectId;
    }).rejects.toThrow(/missing or invalid auth/i);

    using garbageSession = withItxSession();
    await expect(async () => {
      using denied = garbageSession.authenticate({
        type: "project-app-session",
        token: "not.a.jwt",
      });
      using deniedProject = denied.projects.get(projectId);
      await deniedProject.projectId;
    }).rejects.toThrow(/missing or invalid auth/i);
  },
);
