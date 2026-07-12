import { describe, expect, test } from "vitest";
import {
  CAPABILITY_FETCH_DISPATCH_HEADER,
  parseCapabilityUrl,
  takeCapabilityDispatch,
  withCapabilityDispatchHeader,
} from "./capability-url.ts";

describe("parseCapabilityUrl", () => {
  test("explicit projectId form: <cap>.<projectId>.iterate", () => {
    expect(parseCapabilityUrl("http://jonascomputer.prj_123.iterate/ws?x=1")).toEqual({
      projectId: "prj_123",
      scope: "/",
      capabilityPath: ["jonascomputer"],
    });
  });

  test("short form inherits the caller's project (projectId null)", () => {
    expect(parseCapabilityUrl("http://jonascomputer.iterate/")).toEqual({
      projectId: null,
      scope: "/",
      capabilityPath: ["jonascomputer"],
    });
  });

  test("host is lowercased by the URL parser, so labels come back lowercase", () => {
    // The mount is camelCase (itx.jonasComputer); serve-time resolution matches
    // case-insensitively. Here we only assert the parser reflects DNS folding.
    expect(parseCapabilityUrl("http://jonasComputer.PRJ_ABC.iterate/")).toEqual({
      projectId: "prj_abc",
      scope: "/",
      capabilityPath: ["jonascomputer"],
    });
  });

  test("path and query are ignored for addressing (they ride the request)", () => {
    expect(
      parseCapabilityUrl("http://api.prj_1.iterate/v1/things?limit=3")?.capabilityPath,
    ).toEqual(["api"]);
  });

  test("a bare {projectId}.iterate names no capability → null", () => {
    expect(parseCapabilityUrl("http://prj_123.iterate/")).toBeNull();
  });

  test("non-.iterate hosts are not capability URLs", () => {
    expect(parseCapabilityUrl("https://example.com/")).toBeNull();
    expect(parseCapabilityUrl("https://slug.iterate.app/")).toBeNull();
  });

  test("a non-URL string is simply not a capability URL (never throws)", () => {
    expect(parseCapabilityUrl("not a url")).toBeNull();
    expect(parseCapabilityUrl("")).toBeNull();
  });
});

describe("capability dispatch header", () => {
  test("round-trips the capability path and strips the header", () => {
    const request = withCapabilityDispatchHeader(new Request("http://x.iterate/"), {
      capabilityPath: ["jonascomputer"],
    });
    expect(request.headers.get(CAPABILITY_FETCH_DISPATCH_HEADER)).not.toBeNull();

    const taken = takeCapabilityDispatch(request);
    expect(taken?.capabilityPath).toEqual(["jonascomputer"]);
    // The header is removed before the request reaches the capability.
    expect(taken?.request.headers.get(CAPABILITY_FETCH_DISPATCH_HEADER)).toBeNull();
  });

  test("returns null when the header is absent", () => {
    expect(takeCapabilityDispatch(new Request("http://x.iterate/"))).toBeNull();
  });
});
