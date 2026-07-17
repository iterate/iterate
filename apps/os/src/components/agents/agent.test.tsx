import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { ZERO_AGENT_RUNTIME } from "@iterate-com/shared/agent-events";
import { agentCommandAccessibleLabel } from "./agent-presentation.ts";
import {
  AgentCommandPresentation,
  AgentDetailCard,
  AgentListRow,
  AgentSidebarRow,
} from "./agent.tsx";
import { buildAgentForest } from "./agent-tree.ts";
import type { AgentRecord } from "~/domains/agents/agent-presence.ts";

const CREATED_AT = "2026-07-17T10:00:00.000Z";

function record(path: string, input: Partial<AgentRecord> = {}): AgentRecord {
  return {
    path,
    metadata: { pinned: false },
    runtime: ZERO_AGENT_RUNTIME,
    timestamps: { createdAt: CREATED_AT, lastWorkAt: CREATED_AT },
    ...input,
  };
}

describe("Agent presentation family", () => {
  test("the cmdk projection stays passive while retaining provider, state, and tree affordances", () => {
    const parent = record("/agents/slack/C123/111.222", {
      binding: {
        type: "slack_thread",
        connection: "main",
        channelId: "C123",
        threadTs: "111.222",
        channelName: "research",
      },
      metadata: { pinned: true, title: "Research", activity: "Reading papers" },
      runtime: {
        ...ZERO_AGENT_RUNTIME,
        llmRequests: { scheduled: 0, requested: 1, started: 0 },
      },
    });
    const child = record(`${parent.path}/child`);
    const [node] = buildAgentForest({ [parent.path]: parent, [child.path]: child });
    if (node === undefined) throw new Error("missing test node");

    const markup = renderToStaticMarkup(
      <AgentCommandPresentation expanded={false} node={node} nowMs={Date.parse(CREATED_AT)} />,
    );

    expect(markup).toContain("data-agent-disclosure");
    expect(markup).toContain("data-agent-pin");
    expect(markup).toContain("Slack · research");
    expect(markup).toContain("Waiting for model");
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("<a");
    expect(agentCommandAccessibleLabel(node, false)).toContain(
      "Child agents collapsed; press Right Arrow to expand.",
    );
    expect(agentCommandAccessibleLabel(node, false)).toContain("Shift+P to unpin");
  });

  test("the sidebar row is a two-line shortcut: title and live activity, nothing else", () => {
    const agent = record("/agents/inbox", {
      binding: {
        type: "email_thread",
        threadId: "t-onboarding",
        subject: "Enterprise onboarding",
      },
      metadata: {
        pinned: true,
        title: "Customer inbox",
        activity: "Triaging customer mail",
        summary: "A long summary that must never render in the sidebar.",
      },
    });
    const [node] = buildAgentForest({ [agent.path]: agent });
    if (node === undefined) throw new Error("missing test node");

    const markup = renderToStaticMarkup(<AgentSidebarRow node={node} onOpen={() => undefined} />);

    expect(markup).toContain("Customer inbox");
    expect(markup).toContain("Triaging customer mail");
    expect(markup).toContain('data-agent-variant="sidebar"');
    expect(markup).not.toContain("never render in the sidebar");
    expect(markup).not.toContain("<time");
    // Pinning has no sidebar affordance; grouping order carries it instead.
    expect(markup).not.toContain("Unpin agent");
  });

  test("a collapsed catalog row aggregates its subtree into the dot and a subagent count", () => {
    const parent = record("/agents/release", {
      metadata: { pinned: false, title: "Release readiness", activity: "Waiting for approval" },
    });
    const child = record("/agents/release/child", {
      runtime: { ...ZERO_AGENT_RUNTIME, runningScripts: 1 },
      timestamps: {
        createdAt: CREATED_AT,
        lastWorkAt: "2026-07-17T10:05:00.000Z",
        runtimeUpdatedAt: "2026-07-17T10:05:00.000Z",
      },
    });
    const [node] = buildAgentForest({ [parent.path]: parent, [child.path]: child });
    if (node === undefined) throw new Error("missing test node");

    const markup = renderToStaticMarkup(
      <AgentListRow
        node={node}
        nowMs={Date.parse(CREATED_AT)}
        expanded={false}
        onOpen={() => undefined}
        onTogglePinned={() => undefined}
        onToggleChildren={() => undefined}
      />,
    );

    expect(markup).toContain('data-agent-state="running_code"');
    expect(markup).toContain("Running code");
    expect(markup).toContain("1 subagent");
    expect(markup).toContain("Waiting for approval");
    expect(markup).toContain('aria-label="Expand child agents"');
    // The catalog row stays terse: no runtime-count chips, no path text.
    expect(markup).not.toContain("1 script");
    expect(markup).not.toContain(">/agents/release<");
  });

  test("detail renders the complete path, self state, and every available exact timestamp", () => {
    const agent = record("/agents/a/long/and-readable/path", {
      metadata: {
        pinned: false,
        activity: "A complete current-condition sentence that may wrap across several lines.",
        summary:
          "A full two-sentence summary belongs in the roomy detail header. It must remain readable even when the viewport makes it wrap beyond two visual lines.",
        waitingFor: "user_input",
      },
      timestamps: {
        createdAt: CREATED_AT,
        lastWorkAt: "2026-07-17T10:01:00.000Z",
        metadataUpdatedAt: "2026-07-17T10:02:00.000Z",
        activityUpdatedAt: "2026-07-17T10:03:00.000Z",
        runtimeUpdatedAt: "2026-07-17T10:04:00.000Z",
      },
    });
    const markup = renderToStaticMarkup(
      <AgentDetailCard
        agent={agent}
        nowMs={Date.parse(CREATED_AT)}
        onTogglePinned={() => undefined}
      />,
    );

    expect(markup).toContain(agent.path);
    expect(markup).toContain("Needs input");
    expect(markup).toContain("current-condition sentence");
    expect(markup).toContain("two-sentence summary");
    expect(markup).toContain("Created");
    expect(markup).toContain("Last work");
    expect(markup).toContain("Metadata updated");
    expect(markup).toContain("Activity updated");
    expect(markup).toContain("Runtime updated");
    expect(markup).toContain("2026-07-17T10:04:00.000Z");
  });

  test("detail exposes unready triggers as a neutral diagnostic without inventing a queue", () => {
    const agent = record("/agents/unready", {
      runtime: {
        ...ZERO_AGENT_RUNTIME,
        triggers: { pending: 2, runnable: 0 },
      },
    });

    const markup = renderToStaticMarkup(
      <AgentDetailCard
        agent={agent}
        nowMs={Date.parse(CREATED_AT)}
        onTogglePinned={() => undefined}
      />,
    );

    expect(markup).toContain("Idle");
    expect(markup).toContain("2 pending triggers");
    expect(markup).not.toContain("Queued");
  });
});
