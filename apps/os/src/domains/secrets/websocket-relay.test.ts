import { describe, expect, test } from "vitest";
import {
  buildIdentifyFrame,
  injectTokenPlaceholder,
  messageDataToText,
} from "./websocket-relay.ts";

describe("injectTokenPlaceholder", () => {
  test("replaces $token leaves deeply", () => {
    expect(
      injectTokenPlaceholder(
        { op: "identify", token: "$token", nested: { a: "$token", b: 1 } },
        "sekrit",
      ),
    ).toEqual({ op: "identify", token: "sekrit", nested: { a: "sekrit", b: 1 } });
  });

  test("leaves other strings alone", () => {
    expect(injectTokenPlaceholder({ op: "identify", token: "literal" }, "sekrit")).toEqual({
      op: "identify",
      token: "literal",
    });
  });
});

describe("buildIdentifyFrame", () => {
  test("defaults to Discord/petshop identify shape", () => {
    expect(JSON.parse(buildIdentifyFrame("tok-1"))).toEqual({
      op: "identify",
      token: "tok-1",
    });
  });

  test("honors custom frame template", () => {
    expect(
      JSON.parse(
        buildIdentifyFrame("tok-2", { op: "identify", d: { token: "$token", intents: 0 } }),
      ),
    ).toEqual({ op: "identify", d: { token: "tok-2", intents: 0 } });
  });
});

describe("messageDataToText", () => {
  test("handles string and ArrayBuffer", () => {
    expect(messageDataToText("hi")).toBe("hi");
    expect(messageDataToText(new TextEncoder().encode("ab").buffer)).toBe("ab");
  });
});
