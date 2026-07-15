import { expect, test } from "vitest";
import { checkItxScript, type Typechecker } from "../../typecheck/virtual-project.ts";
import { childAgentParentPath } from "../../../lib/agent-paths.ts";
import fixture from "./boop-web-2026-07-15t21-56-48-076z-slow-script-execution.json";

test("boop web stream: tiny script avoids namespace ancestors and source-checking static itx types", async () => {
  // Exact production excerpt: request -> visible message was 5.267s and the
  // durable completion landed at 5.288s. No bulk events were present between
  // these offsets; the status event is retained because it brackets the user's
  // visible wait even though neither processor change consumes it here.
  const requested = fixture.events[0]!;
  const message = fixture.events[3]!;
  const completed = fixture.events[4]!;
  expect(Date.parse(message.createdAt) - Date.parse(requested.createdAt)).toBe(5_267);
  expect(Date.parse(completed.createdAt) - Date.parse(requested.createdAt)).toBe(5_288);

  // `/agents/web` is route syntax, not a capability host. At birth this null
  // semantic parent becomes one explicit root ancestor declaration; the old
  // path-prefix rule activated `/agents/web` and `/agents` on the cold path.
  expect(childAgentParentPath(fixture.agentPath)).toBeNull();

  let files: Record<string, string> | undefined;
  const recordingTypechecker: Typechecker = {
    check: async (input) => {
      files = input.files;
      return { diagnostics: [], notes: [] };
    },
  };
  await checkItxScript({
    capabilities: [],
    code: String(requested.payload.code),
    typechecker: recordingTypechecker,
  });

  // The generated 168 KiB platform surface is trusted declaration input. A
  // `.ts` name defeats skipLibCheck and makes every 73-char script re-check
  // and emit all ~4,000 generated lines.
  expect(files).toHaveProperty("itx-types.d.ts");
  expect(files).not.toHaveProperty("itx-types.ts");
});
