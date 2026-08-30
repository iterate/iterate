/**
 * source.script is HOST TRUTH: every append a script makes journals the
 * script run's identity (executionId + home streamPath), stamped by the
 * trusted append door from the server-minted StreamContext — and any
 * caller-supplied source.script is stripped, whether it comes from inside a
 * script (a forged/laundered stamp) or from an external session (no script
 * at all). Consumers like the agent UI's status attribution rely on this:
 * an event carrying the stamp really was written by that run.
 */
import { test } from "vitest";
import { createTestProject } from "../test-support/create-test-project.ts";
import { itxScript } from "../test-support/itx-script-builder.ts";

const SUMMARY_UPDATED = "events.iterate.com/agent/summary-updated";
const PROBE_TYPE = "events.iterate.test/provenance-probe";

test(
  "script appends journal host-stamped source.script; forged stamps are stripped",
  { timeout: 120_000 },
  async ({ expect }) => {
    await using handle = await createTestProject({ slugPrefix: "script-provenance" });
    using itx = handle.itx();
    const agentPath = "/agents/provenance-target";
    await itx.agents.get(agentPath).create();

    // ── From INSIDE a script (the project-root scope's run lane): a normal
    // agent append plus a probe append that tries to forge the stamp.
    using projectHost = itx.capabilityHosts.get("/");
    await itxScript(projectHost)
      .vars({ agentPath, probeType: PROBE_TYPE, summaryType: SUMMARY_UPDATED })
      .execute(async (itx, vars) => {
        await itx.agents.get(vars.agentPath).append({
          type: "events.iterate.com/agent/summary-updated",
          payload: { activity: "stamped from inside" },
        });
        await itx.streams.get(vars.agentPath).append({
          type: vars.probeType,
          payload: { forged: true },
          source: {
            script: {
              executionId: "forged-execution",
              streamPath: "/forged",
              scriptRunRequestedEventOffset: 1,
            },
          },
        });
        return "done";
      });

    // ── From OUTSIDE any script (this test's own session): a forged stamp
    // must be stripped and nothing substituted — no script wrote this.
    using stream = itx.streams.get(agentPath);
    await stream.append({
      type: PROBE_TYPE,
      payload: { forged: false },
      source: {
        script: {
          executionId: "forged-from-session",
          streamPath: "/forged",
          scriptRunRequestedEventOffset: 1,
        },
      },
    });

    const events = await stream.getEvents({ eventTypes: [SUMMARY_UPDATED, PROBE_TYPE] });
    const summary = events.find((event) => event.type === SUMMARY_UPDATED);
    const probes = events.filter((event) => event.type === PROBE_TYPE);
    expect(probes).toHaveLength(2);
    const [scriptProbe, sessionProbe] = probes;

    // The script's appends carry the run's real identity: the same
    // executionId on both events, the ROOT scope as the home stream (the
    // script ran on the "/" capability host), and never the forged values.
    expect(summary?.source?.script).toMatchObject({
      executionId: expect.stringMatching(/^(?!forged)/),
      streamPath: "/",
      scriptRunRequestedEventOffset: expect.any(Number),
    });
    expect(scriptProbe?.source?.script).toMatchObject({
      executionId: summary?.source?.script?.executionId,
      streamPath: "/",
    });

    // The session append keeps its event but loses the forged stamp entirely.
    expect(sessionProbe?.payload).toMatchObject({ forged: false });
    expect(sessionProbe?.source?.script).toBeUndefined();
  },
);
