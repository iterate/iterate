import { describe, expect, test } from "vitest";
import {
  checkoutWorkspacePath,
  isGuestWorkspacePath,
  parseBoardWorkspacePath,
} from "./checkout-shared.ts";

describe("checkout workspace stream paths", () => {
  test("slug collisions stay distinct workspaces", () => {
    // The "--" separator makes the slug alone non-injective: both of these
    // repos slug to "repos--a--b". The hash tail must keep them apart — a
    // shared path would mean shared overlays, collab sessions, and events.
    const a = checkoutWorkspacePath("20260730-abcd", "/repos/a/b");
    const b = checkoutWorkspacePath("20260730-abcd", "/repos/a--b");
    expect(a).not.toBe(b);
  });

  test("shape: /workspaces/tasks/<checkoutId>~<slug>-<hash8>", () => {
    expect(checkoutWorkspacePath("c1", "/repos/config")).toMatch(
      /^\/workspaces\/tasks\/c1~repos--config-[0-9a-f]{8}$/,
    );
  });

  test("deterministic: the same pair always names the same workspace", () => {
    expect(checkoutWorkspacePath("c1", "/repos/config")).toBe(
      checkoutWorkspacePath("c1", "/repos/config"),
    );
  });

  test("parse is the hash-verified inverse (the sidebar's board detector)", () => {
    const path = checkoutWorkspacePath("20260731-ab_c", "/repos/a/b");
    expect(parseBoardWorkspacePath(path)).toEqual({
      checkoutId: "20260731-ab_c",
      repoPath: "/repos/a/b",
    });
    // "/repos/a--b" slugs identically to "/repos/a/b" — the embedded hash
    // must pick the right reading, not fail it (a board on that repo could
    // never commit otherwise).
    expect(parseBoardWorkspacePath(checkoutWorkspacePath("c1", "/repos/a--b"))).toEqual({
      checkoutId: "c1",
      repoPath: "/repos/a--b",
    });
    expect(parseBoardWorkspacePath("/workspaces/agents/you")).toBeNull();
    expect(parseBoardWorkspacePath("/workspaces/tasks/plain-no-separator")).toBeNull();
  });

  test("guest rule: owned = a board path scoped to its own encoded repo", () => {
    const board = checkoutWorkspacePath("c1", "/repos/config");
    expect(isGuestWorkspacePath(board, "/repos/config")).toBe(false);
    // A board lens pointed at a DIFFERENT mount must not publish it.
    expect(isGuestWorkspacePath(board, "/repos/other")).toBe(true);
    expect(isGuestWorkspacePath("/workspaces/agents/you", "/repos/config")).toBe(true);
    // Foreign names under the tasks namespace are not this app's boards.
    expect(isGuestWorkspacePath("/workspaces/tasks/plain-no-separator", "/repos/config")).toBe(
      true,
    );
  });
});
