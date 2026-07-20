import { describe, expect, it } from "vitest";
import { RepoCreateRequest } from "./repo-processor-contract.ts";

describe("RepoCreateRequest", () => {
  it.each([
    { type: "empty" },
    { type: "github-private", connection: "install-1", owner: "acme", repo: "private" },
    { type: "github-public", connection: "install-1", owner: "acme", repo: "public" },
    {
      type: "github-public",
      connection: "install-1",
      depth: 1,
      owner: "acme",
      repo: "public",
    },
  ])("accepts $type", (request) => {
    expect(RepoCreateRequest.parse(request)).toEqual(request);
  });

  it("rejects source fields on an empty repo request", () => {
    expect(() => RepoCreateRequest.parse({ type: "empty", owner: "acme" })).toThrow();
  });

  it("requires GitHub coordinates for both GitHub modes", () => {
    expect(() => RepoCreateRequest.parse({ type: "github-public", owner: "acme" })).toThrow();
    expect(() => RepoCreateRequest.parse({ type: "github-private", repo: "private" })).toThrow();
  });

  it("requires a positive public import depth", () => {
    expect(() =>
      RepoCreateRequest.parse({
        type: "github-public",
        connection: "install-1",
        depth: 0,
        owner: "acme",
        repo: "public",
      }),
    ).toThrow();
  });
});
