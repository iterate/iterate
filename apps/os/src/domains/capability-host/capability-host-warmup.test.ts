import { describe, expect, it, vi } from "vitest";
import { warmCapabilityHostDependencies } from "./capability-host-warmup.ts";

describe("warmCapabilityHostDependencies", () => {
  it("starts the typechecker while durable host state is loading, then warms only the declared ancestor", async () => {
    let finishCatchUp!: () => void;
    const catchUp = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCatchUp = resolve;
        }),
    );
    const ancestorPath = vi.fn(async () => "/declared-parent");
    const warmAncestor = vi.fn(async () => undefined);
    const warmTypechecker = vi.fn(async () => undefined);

    const warming = warmCapabilityHostDependencies({
      ancestorPath,
      catchUp,
      path: "/agents/child",
      visitedScopePaths: [],
      warmAncestor,
      warmTypechecker,
    });
    await Promise.resolve();

    expect(catchUp).toHaveBeenCalledOnce();
    expect(warmTypechecker).toHaveBeenCalledOnce();
    expect(ancestorPath).not.toHaveBeenCalled();
    expect(warmAncestor).not.toHaveBeenCalled();

    finishCatchUp();
    await warming;

    expect(ancestorPath).toHaveBeenCalledOnce();
    expect(warmAncestor).toHaveBeenCalledWith("/declared-parent", ["/agents/child"]);
  });

  it("warms no inferred path for a root host with no ancestor", async () => {
    const warmAncestor = vi.fn(async () => undefined);
    await warmCapabilityHostDependencies({
      ancestorPath: async () => null,
      catchUp: async () => undefined,
      path: "/",
      visitedScopePaths: [],
      warmAncestor,
      warmTypechecker: async () => undefined,
    });
    expect(warmAncestor).not.toHaveBeenCalled();
  });

  it("rejects self ancestry before making a recursive Durable Object call", async () => {
    const warmAncestor = vi.fn(async () => undefined);
    await expect(
      warmCapabilityHostDependencies({
        ancestorPath: async () => "/agents/self",
        catchUp: async () => undefined,
        path: "/agents/self",
        visitedScopePaths: [],
        warmAncestor,
        warmTypechecker: async () => undefined,
      }),
    ).rejects.toThrow('capability-host "/agents/self" cannot be its own ancestor');
    expect(warmAncestor).not.toHaveBeenCalled();
  });

  it("rejects a corrupt ancestor cycle with the complete traversal", async () => {
    await expect(
      warmCapabilityHostDependencies({
        ancestorPath: async () => "/agents/b",
        catchUp: async () => undefined,
        path: "/agents/a",
        visitedScopePaths: ["/agents/a", "/agents/b"],
        warmAncestor: async () => undefined,
        warmTypechecker: async () => undefined,
      }),
    ).rejects.toThrow("capability-host warmup ancestor cycle: /agents/a -> /agents/b -> /agents/a");
  });
});
