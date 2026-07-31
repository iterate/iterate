import { describe, expect, test } from "vitest";
import { checkoutWorkspacePath } from "./checkout-shared.ts";

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
});
