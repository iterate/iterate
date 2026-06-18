// The admin-only platform root (src/itx/root.ts), served at /api/itx. Proves an
// admin can list projects and read/write the `__null__` platform streams, and
// that a non-admin is refused at the door.

import { describe, expect, it } from "vitest";
import { adminToken, baseUrl, connectRoot, token } from "./e2e-env.ts";

const rid = Math.random().toString(36).slice(2, 8);

describe("itx admin root e2e", () => {
  it("lists projects and reads/writes __null__ streams as an admin", async () => {
    using root = connectRoot();

    const projects = await root.projects.list();
    expect([...projects].sort()).toEqual(["prj_alice", "prj_bob", "prj_ref"]);

    // Streams are pre-scoped to __null__: the caller passes a PATH only.
    const path = `/integrations/slack/webhooks/${rid}`;
    using log = await root.streams.get(path);
    const appended = await log.append({
      event: {
        type: "events.iterate.com/test/webhook",
        payload: { hello: "world", rid },
      },
    });
    expect(typeof appended.offset).toBe("number");

    const events = await log.getEvents();
    expect(events.at(-1)?.payload).toMatchObject({ hello: "world", rid });
  });

  it("refuses a non-admin principal at the root door", async () => {
    const response = await fetch(`${baseUrl()}/api/itx`, {
      headers: { authorization: `Bearer ${token()}` }, // alice — not an admin
    });
    expect(response.status).toBe(403);
  });

  it("refuses an unauthenticated request at the root door", async () => {
    const response = await fetch(`${baseUrl()}/api/itx`);
    expect(response.status).toBe(401);
  });

  // The admin token is wired and distinct from the demo principal.
  it("uses a dedicated admin token", () => {
    expect(adminToken()).not.toBe(token());
  });
});
