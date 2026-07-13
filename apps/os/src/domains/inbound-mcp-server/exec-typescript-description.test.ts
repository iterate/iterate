import { describe, expect, it } from "vitest";
import {
  EXEC_TYPESCRIPT_DESCRIPTION,
  inboundMcpServerInstructions,
} from "./exec-typescript-description.ts";

describe("inbound MCP client guidance", () => {
  it("puts the itx execution and discovery contract on both client-visible surfaces", () => {
    const serverInstructions = inboundMcpServerInstructions({ withAgent: false });

    for (const guidance of [serverInstructions, EXEC_TYPESCRIPT_DESCRIPTION]) {
      expect(guidance).toContain("async (itx) => { ... }");
      expect(guidance).toContain("itx.docs.search");
      expect(guidance).toContain("itx.docs.get");
      expect(guidance).toContain("__describe()");
      expect(guidance).toContain("itx.repo");
    }
  });

  it("teaches the full research ladder and representative scripts", () => {
    expect(EXEC_TYPESCRIPT_DESCRIPTION).toContain("itx.docs.typecheck");
    expect(EXEC_TYPESCRIPT_DESCRIPTION).toContain("fetchCall");
    expect(EXEC_TYPESCRIPT_DESCRIPTION).toContain("AGENTS.md");
    expect(EXEC_TYPESCRIPT_DESCRIPTION).toContain("https://github.com/iterate/iterate");
    expect(EXEC_TYPESCRIPT_DESCRIPTION).toContain("apps/os/src/README.md");
    expect(EXEC_TYPESCRIPT_DESCRIPTION).toContain("apps/os/docs/");
    expect(EXEC_TYPESCRIPT_DESCRIPTION).toContain("apps/os/src/itx/examples.ts");
    expect(EXEC_TYPESCRIPT_DESCRIPTION).toContain("itx.integrations.list()");
    expect(EXEC_TYPESCRIPT_DESCRIPTION).toContain("itx.mcp.exa.web_search_exa");

    const representativeScripts = EXEC_TYPESCRIPT_DESCRIPTION.match(/async \(itx\) => \{/g) ?? [];
    expect(representativeScripts.length).toBeGreaterThanOrEqual(4);
    expect(EXEC_TYPESCRIPT_DESCRIPTION).toContain("```ts");
    expect(EXEC_TYPESCRIPT_DESCRIPTION).not.toMatch(/JavaScript|```js(?:\s|$)|\bITX\b/);
  });

  it("puts the fence contract and source pointers before aggressively truncated previews", () => {
    const clientPreview = EXEC_TYPESCRIPT_DESCRIPTION.slice(0, 600);

    expect(clientPreview).toContain("```ts");
    expect(clientPreview).toContain("https://github.com/iterate/iterate");
    expect(clientPreview).toContain("apps/os/src/README.md");
    expect(clientPreview).toContain("apps/os/docs/");
  });

  it("front-loads a runnable discovery example before normal client truncation", () => {
    const clientPreview = EXEC_TYPESCRIPT_DESCRIPTION.slice(0, 1_500);

    expect(clientPreview).toContain("async (itx) => {");
    expect(clientPreview).toContain("itx.docs.search");
    expect(clientPreview).toContain("fetchCall");
    expect(clientPreview).toContain("itx.docs.get");
    expect(clientPreview).toContain("itx.docs.typecheck");
  });

  it("keeps platform-agent turn-taking mechanics out of MCP guidance", () => {
    const corpus = [
      inboundMcpServerInstructions({ withAgent: true }),
      EXEC_TYPESCRIPT_DESCRIPTION,
    ].join("\n");

    expect(corpus).not.toContain("respond with exactly ONE fenced");
    expect(corpus).not.toContain("arrives as your next input");
    expect(corpus).not.toContain("you get another turn");
    expect(corpus).not.toContain("itx.chat.sendMessage");
  });

  it("only advertises ask_assistant when the MCP surface enables it", () => {
    expect(inboundMcpServerInstructions({ withAgent: false })).not.toContain("ask_assistant");
    expect(inboundMcpServerInstructions({ withAgent: true })).toContain("ask_assistant");
  });
});
