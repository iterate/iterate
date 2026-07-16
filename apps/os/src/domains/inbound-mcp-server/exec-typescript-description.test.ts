// Positional truncation invariants for the exec_typescript tool description.
// MCP clients truncate tool descriptions aggressively, so WHERE guidance sits
// is a real client-facing constraint: the fence contract, source pointers,
// and a runnable discovery example must survive the first truncation windows.
// (Phrase-by-phrase copy pinning of the prompt's prose was deliberately
// deleted — docs/testing.md "What earns a test".)
import { describe, expect, it } from "vitest";
import { EXEC_TYPESCRIPT_DESCRIPTION } from "./exec-typescript-description.ts";

describe("inbound MCP client guidance", () => {
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

  it("speaks exactly one fence dialect: ts", () => {
    expect(EXEC_TYPESCRIPT_DESCRIPTION).toContain("```ts");
    expect(EXEC_TYPESCRIPT_DESCRIPTION).not.toMatch(/JavaScript|```js(?:\s|$)|\bITX\b/);
  });
});
