import { expect, it } from "vitest";

import { formatScriptError } from "./itx.ts";

// Regression for the PR #1612 production smoke finding: remote script errors
// (e.g. `repo.edit` rejecting a missing `message`) printed as a stack dump
// with the actual error message buried mid-transport-frames. The rendering
// must lead with the message and surface enumerable extras like the Slack
// SDK's `code`/`data`.
it("leads with the message and surfaces enumerable extras of remote errors", () => {
  const remote = new Error("An API error occurred: not_authed");
  Object.assign(remote, { code: "slack_webapi_platform_error", data: { error: "not_authed" } });

  const rendered = formatScriptError(remote);

  expect(rendered.startsWith("itx script failed: An API error occurred: not_authed\n")).toBe(true);
  expect(rendered).toContain('code: "slack_webapi_platform_error"');
  expect(rendered).toContain('data: {"error":"not_authed"}');
  // The stack stays available but indented below the headline, without
  // repeating the message line.
  expect(rendered).toContain("  at ");
  expect(rendered).not.toContain("Error: An API error occurred");
});

it("renders non-Error throws as JSON", () => {
  expect(formatScriptError({ reason: "nope" })).toBe('itx script failed: {"reason":"nope"}\n');
});
