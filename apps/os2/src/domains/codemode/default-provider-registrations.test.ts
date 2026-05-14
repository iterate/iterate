import { describe, expect, test } from "vitest";
import { createDefaultCodemodeProviderRegistrations } from "./default-provider-registrations.ts";

describe("default codemode provider registrations", () => {
  test("loads public Exa and Context7 MCP providers in every codemode session", () => {
    const providers = createDefaultCodemodeProviderRegistrations({
      projectId: "proj__test__defaults",
      streamPath: "/codemode-sessions/defaults",
    });

    expect(providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ["mcp", "exa"],
          instructions: expect.stringContaining("ctx.mcp.exa"),
        }),
        expect.objectContaining({
          path: ["mcp", "context7"],
          instructions: expect.stringContaining("ctx.mcp.context7"),
        }),
      ]),
    );
    expect(providers.map((provider) => provider.path.join("."))).toEqual(
      expect.arrayContaining(["mcp.exa", "mcp.context7"]),
    );
  });

  test("tells Slack agents to stay quiet unless a reply is needed", () => {
    const providers = createDefaultCodemodeProviderRegistrations({
      projectId: "proj__test__defaults",
      streamPath: "/codemode-sessions/defaults",
    });

    const slackProvider = providers.find((provider) => provider.path.join(".") === "slack");

    expect(slackProvider?.instructions).toContain("explicitly mentioned");
    expect(slackProvider?.instructions).toContain(
      "surrounding thread context clearly calls for agent action",
    );
    expect(slackProvider?.instructions).toContain(
      "If no reply is needed, do not call chat.postMessage.",
    );
  });

  test("registers project Sandboxes as a default codemode provider", () => {
    const providers = createDefaultCodemodeProviderRegistrations({
      projectId: "proj__test__defaults",
      streamPath: "/codemode-sessions/defaults",
    });

    const sandboxesProvider = providers.find((provider) => provider.path.join(".") === "sandboxes");

    expect(sandboxesProvider?.instructions).toContain("ctx.sandboxes.getInitialized({ slug })");
    expect(sandboxesProvider?.instructions).toContain("/workspace/iterate-config");
    expect(sandboxesProvider?.invocation).toEqual(
      expect.objectContaining({
        kind: "rpc",
      }),
    );
  });
});
