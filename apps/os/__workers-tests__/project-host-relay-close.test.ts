// A bearer's WebSocket on a project host, relayed by the edge on the grant's lease
// (src/project-host-lease.ts): a close on the app's end reaches the client. A connection that
// dropped without a close frame, which the runtime reports as 1006, is no normal closure: the
// client hears 1011, never 1000.
import { env } from "cloudflare:workers";
import { expect, onTestFinished, test } from "vitest";
import type { AccessGrant } from "../src/oauth.ts";
import { leasedProjectHostAnswer } from "../src/project-host-lease.ts";

test.for([
  {
    name: "a connection that dropped (1006)",
    app: { code: 1006, reason: "WebSocket disconnected without sending Close frame." },
    client: { code: 1011, reason: "WebSocket disconnected without sending Close frame." },
  },
  {
    name: "a close frame with no code (1005)",
    app: { code: 1005, reason: "" },
    client: { code: 1000, reason: "" },
  },
  {
    name: "the app's own close",
    app: { code: 4001, reason: "bye" },
    client: { code: 4001, reason: "bye" },
  },
  {
    // 200 UTF-8 bytes: workerd refuses a close reason past 123 bytes, whole characters kept.
    name: "a close whose reason is past 123 bytes",
    app: { code: 4001, reason: "é".repeat(100) },
    client: { code: 4001, reason: "é".repeat(61) },
  },
])("$name on the app's end closes the client $client.code", async ({ app, client }) => {
  const upstream = new AppSocket();
  // A 101's shape as the edge reads it: a Response cannot carry a WebSocket the runtime did not make.
  const answer = { webSocket: upstream, headers: new Headers() } as unknown as Response;
  const relayed = leasedProjectHostAnswer(
    env,
    grant,
    { projectIds: ["prj_relay"] },
    "prj_relay",
    answer,
  );
  expect(relayed).toMatchObject({ status: 101 });
  const socket = relayed.webSocket!;
  socket.accept();
  onTestFinished(() => {
    try {
      socket.close(1000, "done");
    } catch {
      // closed by the relay
    }
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    socket.addEventListener("close", ({ code, reason }) => resolve({ code, reason }), {
      once: true,
    }),
  );
  upstream.dispatchEvent(new CloseEvent("close", { ...app, wasClean: false }));
  expect(await closed).toEqual(client);
});

/** The app's end of the relay as the edge holds it: the test closes it as the runtime would. */
class AppSocket extends EventTarget {
  accept() {}
  send() {}
  close() {}
}

const grant = {
  kind: "personal",
  userId: "user_relay",
  email: "relay@example.com",
  projects: ["prj_relay"],
  deadline: Infinity,
  grantId: "pat_0000000000000000",
  scope: ["iterate"],
  expiresAt: Infinity,
} as AccessGrant;
