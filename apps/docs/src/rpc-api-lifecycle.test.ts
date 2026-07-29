import { beforeEach, describe, expect, test, vi } from "vitest";

const lifecycle = vi.hoisted(() => ({
  close: vi.fn(),
}));

vi.mock("@iterate-com/workspace-documents/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@iterate-com/workspace-documents/server")>();
  return {
    ...actual,
    ProjectDial: class {
      close = lifecycle.close;

      withProject<T>(
        operation: (project: { identity(): Promise<{ projectId: string }> }) => PromiseLike<T>,
      ): PromiseLike<T> {
        return operation({
          identity: async () => ({ projectId: "prj_docs_test" }),
        });
      }
    },
  };
});

import { DocsApiRoot } from "./rpc-api.ts";

describe("Docs project lifecycle", () => {
  beforeEach(() => lifecycle.close.mockClear());

  test("closes the downstream OS connection when the project capability is released", async () => {
    const root = new DocsApiRoot(
      { OS_BASE_URL: "https://os.example.com" },
      new Request("https://docs.example.com/api"),
    );
    const project = await root.authenticate({
      projectId: "prj_docs_test",
      secret: "test-secret",
      type: "project-secret",
    });

    expect(lifecycle.close).not.toHaveBeenCalled();

    (project as Partial<Disposable>)[Symbol.dispose]?.();

    expect(lifecycle.close).toHaveBeenCalledOnce();
  });
});
