import { describe, expect, test } from "vitest";
import { buildStreamTuiPilottySpawnArgs } from "./pilotty-command.ts";

describe("buildStreamTuiPilottySpawnArgs", () => {
  test("places pilotty flags before the spawned command positionals", () => {
    expect(
      buildStreamTuiPilottySpawnArgs({
        sessionName: "stream-tui",
        cwd: "/repo",
        projectId: "prj_demo",
        agentPath: "/agents/onboarding",
      }),
    ).toEqual([
      "spawn",
      "--name",
      "stream-tui",
      "--cwd",
      "/repo",
      "node",
      "packages/iterate/bin/iterate.js",
      "chat",
      "--project",
      "prj_demo",
      "--agent-path",
      "/agents/onboarding",
    ]);
  });
});
