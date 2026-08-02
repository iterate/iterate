import { describe, expect, test } from "vitest";
import { boardAddressFor, checkoutWorkspacePath, isGuestWorkspacePath } from "./checkout-shared.ts";

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

  test("board addresses resolve exactly against the project's repos", () => {
    // "/repos/a/b" and "/repos/a--b" slug identically; re-minting per repo
    // resolves each to ITS own board, however deep the path nests.
    const repos = ["/repos/a/b", "/repos/a--b", "/repos/deep/a/b/c/d/e/f/g/h", "/repos/config"];
    for (const repoPath of repos) {
      expect(boardAddressFor(checkoutWorkspacePath("20260731-ab_c", repoPath), repos)).toEqual({
        checkoutId: "20260731-ab_c",
        repoPath,
      });
    }
    // Not a board: an agent's workspace, a foreign tasks-namespace name, or
    // a board on a repo this project does not have.
    expect(boardAddressFor("/workspaces/agents/you", repos)).toBeNull();
    expect(boardAddressFor("/workspaces/tasks/plain-no-separator", repos)).toBeNull();
    expect(boardAddressFor(checkoutWorkspacePath("c1", "/repos/gone"), repos)).toBeNull();
  });

  test("guest rule: owned = a board path scoped to its own encoded repo", () => {
    const board = checkoutWorkspacePath("c1", "/repos/config");
    expect(isGuestWorkspacePath(board, "/repos/config")).toBe(false);
    // However deeply the repo nests, the app's OWN board stays owned — the
    // check re-mints rather than parsing the ambiguous slug.
    const deep = "/repos/a/b/c/d/e/f/g/h";
    expect(isGuestWorkspacePath(checkoutWorkspacePath("c1", deep), deep)).toBe(false);
    // A board lens pointed at a DIFFERENT mount must not publish it.
    expect(isGuestWorkspacePath(board, "/repos/other")).toBe(true);
    expect(isGuestWorkspacePath("/workspaces/agents/you", "/repos/config")).toBe(true);
    // Foreign names under the tasks namespace are not this app's boards.
    expect(isGuestWorkspacePath("/workspaces/tasks/plain-no-separator", "/repos/config")).toBe(
      true,
    );
  });
});
