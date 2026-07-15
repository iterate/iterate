import { expect, it } from "vitest";
import { create } from "./session.ts";

// The one kernel worth keeping from this CLI's tests: an operator session is
// either project-confined or explicitly platform-wide — never both, never
// neither. `create` enforces this before reading env or touching the network,
// so the guard needs no mocks. Everything else about the command (request
// shape, URL printing, browser opening) is glue the covering flows exercise.
it("requires exactly one authority mode", async () => {
  await expect(create({ admin: true, project: "test" })).rejects.toThrow("exactly one");
  await expect(create({ operator: "support@example.test" })).rejects.toThrow("exactly one");
});
