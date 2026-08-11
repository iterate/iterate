import { describe, expect, it, vi } from "vitest";
import { configRepoTemplateFromSlug, slugConfigTemplateExists } from "./slug-config-template.ts";

describe("configRepoTemplateFromSlug", () => {
  it("pins a pr-prefixed slug to that pull request's head ref", () => {
    expect(configRepoTemplateFromSlug("pr2477-template-waiter-chef")).toBe(
      "github:iterate/iterate#pull/2477/head&path:configs/waiter-chef",
    );
  });

  it("pins the ref when the prefix merely starts with pr<N> (collision-free slugs)", () => {
    expect(configRepoTemplateFromSlug("pr2477-alice-template-waiter-chef")).toBe(
      "github:iterate/iterate#pull/2477/head&path:configs/waiter-chef",
    );
  });

  it("leaves the ref on the default branch for ordinary prefixes", () => {
    expect(configRepoTemplateFromSlug("acme-template-with-voice")).toBe(
      "github:iterate/iterate#path:configs/with-voice",
    );
  });

  it("splits on the FIRST -template- so template names keep their hyphens", () => {
    expect(configRepoTemplateFromSlug("x-template-waiter-chef-v2")).toBe(
      "github:iterate/iterate#path:configs/waiter-chef-v2",
    );
  });

  it("ignores slugs without the convention", () => {
    expect(configRepoTemplateFromSlug("nustom")).toBeNull();
    expect(configRepoTemplateFromSlug("template-foo")).toBeNull();
    expect(configRepoTemplateFromSlug("foo-template-")).toBeNull();
  });
});

describe("slugConfigTemplateExists", () => {
  it("asks the GitHub contents API for the template folder at the pinned ref", async () => {
    const githubFetch = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));

    await expect(
      slugConfigTemplateExists(
        "github:iterate/iterate#pull/2477/head&path:configs/waiter-chef",
        githubFetch,
      ),
    ).resolves.toBe(true);
    expect(githubFetch.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/iterate/iterate/contents/configs/waiter-chef?ref=pull%2F2477%2Fhead",
    );
  });

  it("treats a 404 as missing", async () => {
    const githubFetch = vi.fn().mockResolvedValue(new Response("nope", { status: 404 }));

    await expect(
      slugConfigTemplateExists("github:iterate/iterate#path:configs/ghost", githubFetch),
    ).resolves.toBe(false);
  });

  it("treats network failure as missing rather than failing project creation", async () => {
    const githubFetch = vi.fn().mockRejectedValue(new Error("github unreachable"));

    await expect(
      slugConfigTemplateExists("github:iterate/iterate#path:configs/with-voice", githubFetch),
    ).resolves.toBe(false);
  });
});
