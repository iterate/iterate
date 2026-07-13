import { describe, expect, test } from "vitest";
import { createItxClientObservability, parseItxCallMetadata } from "./itx-call-metadata.ts";

describe("itx call metadata", () => {
  test("keeps a connection ID stable and creates a call ID per RPC", () => {
    const observability = createItxClientObservability({ client: "node", projectId: "prj_test" });
    const first = observability.getCallMetadata();
    const second = observability.getCallMetadata();

    expect(first.connectionId).toBe(observability.connectionId);
    expect(second.connectionId).toBe(first.connectionId);
    expect(second.callId).not.toBe(first.callId);
    expect(first).toMatchObject({ client: "node", projectId: "prj_test", version: 1 });
  });

  test("accepts the bounded v1 shape and rejects malformed peer input", () => {
    const valid = {
      version: 1,
      callId: "call-1",
      connectionId: "connection-1",
      client: "browser",
    } as const;

    expect(parseItxCallMetadata(valid)).toEqual(valid);
    expect(parseItxCallMetadata({ ...valid, client: "spoofed" })).toBeUndefined();
    expect(parseItxCallMetadata({ ...valid, callId: "x".repeat(129) })).toBeUndefined();
    expect(parseItxCallMetadata(null)).toBeUndefined();
  });
});
