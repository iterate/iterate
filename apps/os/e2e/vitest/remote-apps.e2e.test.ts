import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { RpcTarget, newWebSocketRpcSession } from "capnweb";
import { WebSocketServer } from "ws";
import { expect, test } from "vitest";
import {
  generateProjectApiKeyMaterial,
  PROJECT_API_KEY_SECRET_PATH,
} from "../../src/domains/secrets/utils.ts";
import { adminSecret, buildUrl, deployedBaseUrl, withItxSession } from "./test-helpers.ts";

// The two halves of "externally deployed userspace apps", MVP form:
//
//  INGRESS — an app anywhere on the internet authenticates to /api AS its
//  project with the `project-secret` credential, verified against the
//  write-only secret every project is born with at /secrets/project-api-key.
//  The comparison happens inside the Secret Durable Object; the pairing
//  ceremony is the owner WRITING a value they hold (material is write-only,
//  so nothing ever reads it back).
//
//  EGRESS — the same external app mounts as a project capability: a durable
//  itx-expression names `remoteCapability.get(url, { headers })`, the dial
//  rides project egress, and getSecret(...) placeholders in the headers are
//  substituted server-side by the referenced secret under its origin pin —
//  mutual authentication with no material in the mount.

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

test.skipIf(deployedBaseUrl() !== null)(
  "a remote Cap'n Web app mounts as a project capability, dialed with a secret-substituted header",
  { timeout: 120_000 },
  async () => {
    const egressKey = `remote-egress-${crypto.randomUUID().replaceAll("-", "")}`;
    const todos = new RemoteTodoApp();
    const authorizationSeen: Array<string | undefined> = [];

    // The "externally deployed" todo app: plain node http + ws, no platform
    // code. It rejects any dial that does not present the shared egress key —
    // the mutual-auth check an independent deployment would make.
    const httpServer = createServer();
    const wss = new WebSocketServer({ server: httpServer });
    wss.on("connection", (socket, request) => {
      authorizationSeen.push(request.headers.authorization);
      if (request.headers.authorization !== `Bearer ${egressKey}`) {
        socket.close(4401, "missing or invalid egress credential");
        return;
      }
      // The ws socket satisfies the standard listener surface the Cap'n Web
      // transport uses; the cast bridges node-ws and DOM WebSocket types.
      newWebSocketRpcSession(socket as unknown as WebSocket, todos);
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));

    try {
      const port = (httpServer.address() as AddressInfo).port;
      const remoteUrl = `ws://127.0.0.1:${port}/api`;

      using session = withItxSession();
      using admin = session.authenticate({ type: "admin-secret", secret: adminSecret() });
      using project = admin.projects.create({
        slug: `remote-mount-${crypto.randomUUID().slice(0, 8)}`,
        waitUntilReady: true,
      });
      const projectId = await project.projectId;

      // The egress credential is an ordinary project secret, origin-pinned to
      // the external app — deliberately NOT the ingress key.
      await project.secrets.get("/secrets/remote-todos").create({
        egress: { urls: [`http://127.0.0.1:${port}`] },
        material: { apiKey: egressKey },
      });

      // The durable mount: an expression NAMING the dial. No material, no
      // captured connection — re-evaluated from project authority per invoke.
      await project.capabilityHosts.get("/").provideCapability({
        type: "itx-expression",
        path: ["todos"],
        expression: [
          "remoteCapability",
          [
            "get",
            remoteUrl,
            {
              headers: {
                authorization:
                  'Bearer getSecret({ path: "/secrets/remote-todos", field: "apiKey" })',
              },
            },
          ],
        ],
        instructions: "The project's todo list, served by an externally deployed app.",
      });

      // Invoke through the ordinary dynamic capability path — itx.todos.add —
      // exactly as an agent script would.
      using mountedProject = admin.projects.get(projectId);
      const dynamicProject = mountedProject as unknown as {
        todos: { add(title: string): Promise<number>; list(): Promise<string[]> };
      };
      expect(await dynamicProject.todos.add("prove the remote mount")).toBe(1);
      expect(await dynamicProject.todos.list()).toEqual(["prove the remote mount"]);

      // The external server really saw the substituted credential — material
      // came out of the secret system only inside the pinned handshake.
      expect(authorizationSeen.length).toBeGreaterThan(0);
      expect(authorizationSeen.every((seen) => seen === `Bearer ${egressKey}`)).toBe(true);
      expect(todos).toMatchObject({ items: ["prove the remote mount"] });
    } finally {
      // Per-invoke remote sessions stay open on the platform side (the MVP
      // never closes them), so a graceful close would wait on them forever.
      for (const client of wss.clients) client.terminate();
      wss.close();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    }
  },
);

// Deployed lane (preview/prd): the loopback server above is unreachable from
// a real worker, so prove the remote-dial machinery against a public Cap'n
// Web endpoint instead — the project's own seeded guestbook /api, which is an
// EXTERNAL URL from the platform's point of view (ordinary ingress hostname,
// anonymous dial, no placeholders).
test.skipIf(deployedBaseUrl() === null)(
  "remoteCapability dials a public Cap'n Web endpoint on a deployed stack",
  { timeout: 240_000 },
  async () => {
    using session = withItxSession();
    using admin = session.authenticate({ type: "admin-secret", secret: adminSecret() });
    const slug = `remote-public-${crypto.randomUUID().slice(0, 8)}`;
    using project = admin.projects.create({ slug, waitUntilReady: true });
    const projectId = await project.projectId;

    const base = new URL(buildUrl({ path: "/" }));
    const raw = process.env.APP_CONFIG_PROJECT_HOSTNAME_BASES?.trim();
    const configuredBase = raw ? String((JSON.parse(raw) as string[])[0]) : undefined;
    const previewMatch = /^os\.(iterate-preview-\d+)\.com$/.exec(base.hostname);
    const projectBase = configuredBase || (previewMatch ? `${previewMatch[1]}.app` : base.hostname);
    const guestbookApi = `wss://guestbook--${slug}.${projectBase}/api`;

    await project.capabilityHosts.get("/").provideCapability({
      type: "itx-expression",
      path: ["remoteGuestbook"],
      expression: ["remoteCapability", ["get", guestbookApi]],
    });

    using mountedProject = admin.projects.get(projectId);
    const dynamicProject = mountedProject as unknown as {
      remoteGuestbook: { sign(name: string, message: string): Promise<void> };
    };
    // The first dials may land on the app's cold build (503 from ingress);
    // retry within the budget — the expression re-dials fresh per invoke.
    const deadline = Date.now() + 180_000;
    for (;;) {
      try {
        await dynamicProject.remoteGuestbook.sign("Remote Capability", "dialed from the platform");
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (Date.now() > deadline || !/503|did not accept/.test(message)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    }

    // The signature took the ordinary guestbook path: entry event on the
    // project's /guestbook stream.
    using stream = project.streams.get("/guestbook");
    const entry = await stream.waitForEvent({
      eventTypes: ["events.iterate.com/guestbook/entry-signed"],
      timeoutMs: 30_000,
    });
    expect(entry).toMatchObject({ payload: { name: "Remote Capability" } });
  },
);

// A real external Cap'n Web app for the egress direction: a node WebSocket
// server OUTSIDE the platform, guarding its door with a bearer token. Local
// runs only — a deployed OS worker cannot reach this suite's loopback.
class RemoteTodoApp extends RpcTarget {
  items: string[] = [];
  async add(title: string): Promise<number> {
    this.items.push(title);
    return this.items.length;
  }
  async list(): Promise<string[]> {
    return [...this.items];
  }
}
