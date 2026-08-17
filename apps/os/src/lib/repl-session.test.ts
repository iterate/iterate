import { expect, test } from "vitest";
import { newReplSessionPath, newestReplSessionPath, replSessionSlug } from "./repl-session.ts";

test("newReplSessionPath is a stable slug of the creation time (web-agent convention)", () => {
  expect(newReplSessionPath(new Date("2026-07-17T12:34:56.789Z"))).toBe(
    "/repl/2026-07-17t12-34-56-789z",
  );
});

test("newestReplSessionPath resumes the most recent session and ignores everything else", () => {
  expect(newestReplSessionPath([])).toBeNull();
  expect(
    newestReplSessionPath([
      // not sessions: the retired singleton scope, other surfaces
      { createdAt: "2026-08-01T00:00:00.000Z", path: "/repl" },
      { createdAt: "2026-08-09T00:00:00.000Z", path: "/agents/web/2026-08-09t00-00-00-000z" },
      { createdAt: "2026-08-02T00:00:00.000Z", path: "/repl/2026-08-02t00-00-00-000z" },
      { createdAt: "2026-08-05T00:00:00.000Z", path: "/repl/2026-08-05t00-00-00-000z" },
    ]),
  ).toBe("/repl/2026-08-05t00-00-00-000z");
});

test("replSessionSlug is the URL splat for a session path", () => {
  expect(replSessionSlug("/repl/2026-08-05t00-00-00-000z")).toBe("2026-08-05t00-00-00-000z");
});
