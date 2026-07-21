import { expect, type WebSocketRoute } from "@playwright/test";
import { spinnerWaiter } from "middlewright";
import { connectAdminItx } from "./test-support/forged-session.ts";
import { test } from "./test-support/test.ts";

test("a new agent stream stays initializing while its connection opens", async ({
  baseURL,
  helpers,
  page,
}) => {
  await using fixture = await helpers.createFixture("agent-initializing");
  using admin = await connectAdminItx(baseURL!);
  using project = admin.projects.get(fixture.project.id);
  const agentPath = `/agents/initializing-${crypto.randomUUID().slice(0, 8)}`;
  await project.agents.get(agentPath).create();

  let restoreConnections = false;
  const stalledSockets: WebSocketRoute[] = [];
  await page.routeWebSocket(
    (url) => url.pathname === "/api",
    (socket) => {
      if (restoreConnections) socket.connectToServer();
      else stalledSockets.push(socket);
    },
  );
  await spinnerWaiter.settings.run({ disabled: true }, async () => {
    await page.goto(`/projects/${fixture.project.slug}/agents/streams${agentPath}`);
    await page.getByText("Initializing agent", { exact: true }).waitFor({ timeout: 5_000 });
    await page.getByText("Nothing here yet").waitFor({ state: "hidden" });
    await expect.poll(() => stalledSockets.length).toBeGreaterThan(0);

    restoreConnections = true;
    await Promise.all(stalledSockets.map((socket) => socket.close({ code: 1012 })));
    await page
      .getByText("Initializing agent", { exact: true })
      .waitFor({ state: "hidden", timeout: 30_000 });
  });
});

test("a cached stream opens before its live connection", async ({ baseURL, helpers, page }) => {
  await using fixture = await helpers.createFixture("stream-cache");
  using admin = await connectAdminItx(baseURL!);
  using project = admin.projects.get(fixture.project.id);
  const streamPath = `/spec/cache-before-live-${crypto.randomUUID().slice(0, 8)}`;
  using stream = project.streams.get(streamPath);
  await stream.append({
    type: "events.iterate.com/spec/cached-before-live",
    payload: {},
  });

  const route = `/projects/${fixture.project.slug}/streams${streamPath}`;
  const cachedRow = page
    .getByTestId("stream-feed-inspect")
    .filter({ hasText: "spec/cached-before-live" });

  // Warm the real OPFS mirror, then make only the next /api WebSocket look
  // like a very slow network: it opens but never returns an ITX frame.
  await page.goto(route);
  await cachedRow.waitFor({ timeout: 30_000 });

  // The first tab holds the mirror lock; the follower's own ITX transport can still write.
  const follower = await page.context().newPage();
  await follower.goto(route);
  await follower
    .getByRole("button", { name: "Append events (⌘↵)", disabled: false })
    .waitFor({ timeout: 30_000 });
  await follower.close();

  let restoreConnections = false;
  const stalledSockets: WebSocketRoute[] = [];
  await page.routeWebSocket(
    (url) => url.pathname === "/api",
    (socket) => {
      if (restoreConnections) socket.connectToServer();
      else stalledSockets.push(socket);
    },
  );

  await page.reload();

  await cachedRow.waitFor({ timeout: 5_000 });
  await page.getByTestId("stream-cache-status").waitFor();
  await page.getByRole("button", { name: "Append events (⌘↵)", disabled: true }).waitFor();
  await expect.poll(() => stalledSockets.length).toBeGreaterThan(0);

  restoreConnections = true;
  await Promise.all(
    stalledSockets.map((socket) =>
      socket.close({ code: 1012, reason: "restore the test connection" }),
    ),
  );
  await page.getByTestId("stream-cache-status").waitFor({ state: "hidden", timeout: 30_000 });
  await page.getByRole("button", { name: "Append events (⌘↵)", disabled: false }).waitFor();
  await expect.poll(() => cachedRow.count()).toBe(1);
});
