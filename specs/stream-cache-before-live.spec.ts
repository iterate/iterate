import { expect, type WebSocketRoute } from "@playwright/test";
import { spinnerWaiter } from "middlewright";
import { connectAdminItx } from "./test-support/forged-session.ts";
import { test } from "./test-support/test.ts";

test("an empty agent feed waits for matching events after subscribing", async ({
  baseURL,
  helpers,
  page,
}) => {
  await using fixture = await helpers.createFixture("agent-initializing");
  using admin = await connectAdminItx(baseURL!);
  using project = admin.projects.get(fixture.project.id);
  const agentPath = `/agents/waiting-${crypto.randomUUID().slice(0, 8)}`;
  using agent = project.agents.get(agentPath);

  await spinnerWaiter.settings.run({ disabled: true }, async () => {
    await page.goto(`/projects/${fixture.project.slug}/agents/streams${agentPath}`);
    await expect
      .poll(() =>
        page.evaluate((key) => {
          const read = (
            window as {
              __streamRuntimeDebug?: () => Record<string, unknown>;
            }
          ).__streamRuntimeDebug;
          const entry = read?.()[key] as { connectionStatus?: string } | undefined;
          return entry?.connectionStatus;
        }, `${fixture.project.id} ${agentPath} browser-stream-mirror`),
      )
      .toBe("subscribed");

    await page.getByText("Waiting for events…", { exact: true }).waitFor({ timeout: 5_000 });
    await page.getByText("Nothing here yet").waitFor({ state: "hidden" });
    await page.getByText("No events on this agent stream yet.").waitFor({ state: "hidden" });

    await agent.create();
    await agent.chat.sendMessage("The agent is ready.");
    await page.getByText("The agent is ready.", { exact: true }).waitFor({ timeout: 30_000 });
    await page
      .getByText("Waiting for events…", { exact: true })
      .waitFor({ state: "hidden", timeout: 30_000 });
  });
});

test("a cold stream stays pending until its server history catches up", async ({
  baseURL,
  helpers,
  page,
}) => {
  await using fixture = await helpers.createFixture("stream-cold-history");
  using admin = await connectAdminItx(baseURL!);
  using project = admin.projects.get(fixture.project.id);
  const streamPath = `/spec/cold-history-${crypto.randomUUID().slice(0, 8)}`;
  using stream = project.streams.get(streamPath);
  await stream.append({ type: "events.iterate.com/spec/cold-history", payload: {} });

  await page.routeWebSocket(
    (url) => url.pathname === "/api",
    (socket) => {
      const server = socket.connectToServer();
      socket.onMessage((message) => server.send(message));
      server.onMessage((message) => setTimeout(() => socket.send(message), 1_000));
    },
  );

  await page.goto(`/projects/${fixture.project.slug}/streams${streamPath}`);
  await page
    .getByRole("button", { name: "Append events (⌘↵)", disabled: false })
    .waitFor({ timeout: 30_000 });
  await page.getByText("Connecting to the stream", { exact: true }).waitFor();
  await page.getByText("Nothing here yet").waitFor({ state: "hidden" });
  await page
    .getByTestId("stream-feed-inspect")
    .filter({ hasText: "spec/cold-history" })
    .waitFor({ timeout: 30_000 });
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
