/**
 * Canned Slack Web API success bodies for itx e2e fixtures.
 */
export function mockSlackResponseBody(
  method: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (method === "chat.postMessage") {
    return {
      ok: true,
      channel: payload.channel,
      ts: "1718000000.000100",
      message: { text: payload.text, type: "message" },
      via: "mock-slack-api",
    };
  }
  if (method === "users.list") {
    return {
      ok: true,
      members: [
        { id: "U1", name: "ada" },
        { id: "U2", name: "grace" },
      ],
      via: "mock-slack-api",
    };
  }
  return { ok: true, via: "mock-slack-api" };
}
