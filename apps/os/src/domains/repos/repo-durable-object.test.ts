import { beforeEach, describe, expect, it, vi } from "vitest";
import { DurableObjectNameCodec } from "../durable-object-names.ts";

const lazy = vi.hoisted(() => ({
  create: vi.fn(),
  reader: {
    head: vi.fn(),
    listHead: vi.fn(),
    readHeadPaths: vi.fn(),
  },
}));

vi.mock("./lazy-repo-reader.ts", () => ({
  createLazyRepoReader: lazy.create,
}));

import { RepoDurableObject } from "./repo-durable-object.ts";

const PIN = "a".repeat(40);
const NEWER_PIN = "b".repeat(40);

function repo(): RepoDurableObject {
  return new RepoDurableObject(
    {
      abort: vi.fn(),
      id: {
        name: DurableObjectNameCodec.stringify({
          path: "/repos/config",
          projectId: "prj_snapshot_test",
        }),
      },
      storage: {
        kv: {
          delete: vi.fn(),
          get: vi.fn(),
          put: vi.fn(),
        },
        sql: { exec: vi.fn(() => ({ toArray: () => [] })) },
        transactionSync: <T>(closure: () => T) => closure(),
      },
      waitUntil: vi.fn(),
    } as never,
    {} as never,
  );
}

describe("RepoDurableObject.getFilesSnapshot pinned lazy reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lazy.create.mockReturnValue(lazy.reader);
    lazy.reader.head.mockReturnValue({ commitOid: PIN, rootTreeOid: "tree" });
    lazy.reader.listHead.mockResolvedValue({
      head: { commitOid: PIN, rootTreeOid: "tree" },
      paths: [
        "README.md",
        "src/drop.ts",
        "src/empty.ts",
        "src/extra.ts",
        "src/index.ts",
        "src/link",
      ],
    });
    lazy.reader.readHeadPaths.mockResolvedValue({
      bytes: [
        new Uint8Array(),
        new TextEncoder().encode("source"),
        new TextEncoder().encode("target"),
      ],
      head: { commitOid: PIN, rootTreeOid: "tree" },
    });
  });

  it("serves an exact stored default-branch pin without cloning and applies masks before reads", async () => {
    const object = repo();
    const gitAccess = vi.spyOn(object, "gitAccess").mockRejectedValue(new Error("checkout"));

    await expect(
      object.getFilesSnapshot({
        commitOid: PIN,
        exclude: ["src/drop.ts"],
        include: ["src/**"],
        paths: ["src/empty.ts", "src/index.ts", "src/link"],
      }),
    ).resolves.toEqual({
      commitOid: PIN,
      files: { "src/empty.ts": "", "src/index.ts": "source", "src/link": "target" },
    });

    expect(lazy.reader.readHeadPaths).toHaveBeenCalledWith([
      "src/empty.ts",
      "src/index.ts",
      "src/link",
    ]);
    expect(gitAccess).not.toHaveBeenCalled();
  });

  it("uses the historical checkout when the stored head is not the immutable pin", async () => {
    lazy.reader.head.mockReturnValue({ commitOid: NEWER_PIN, rootTreeOid: "tree" });
    const object = repo();
    const gitAccess = vi.spyOn(object, "gitAccess").mockRejectedValue(new Error("checkout"));

    await expect(object.getFilesSnapshot({ commitOid: PIN })).rejects.toThrow("checkout");
    expect(lazy.reader.listHead).not.toHaveBeenCalled();
    expect(gitAccess).toHaveBeenCalledOnce();
  });

  it.each(["manifest", "blob"] as const)(
    "uses the historical checkout when the lazy head changes at the %s read",
    async (at) => {
      if (at === "manifest") {
        lazy.reader.listHead.mockResolvedValue({
          head: { commitOid: NEWER_PIN, rootTreeOid: "newer-tree" },
          paths: [],
        });
      } else {
        lazy.reader.readHeadPaths.mockResolvedValue({
          bytes: [new TextEncoder().encode("wrong")],
          head: { commitOid: NEWER_PIN, rootTreeOid: "newer-tree" },
        });
      }
      const object = repo();
      const gitAccess = vi.spyOn(object, "gitAccess").mockRejectedValue(new Error("checkout"));

      await expect(object.getFilesSnapshot({ commitOid: PIN })).rejects.toThrow("checkout");
      if (at === "manifest") expect(lazy.reader.readHeadPaths).not.toHaveBeenCalled();
      else expect(lazy.reader.readHeadPaths).toHaveBeenCalledOnce();
      expect(gitAccess).toHaveBeenCalledOnce();
    },
  );

  it("propagates lazy blob failures rather than hiding them behind a checkout", async () => {
    lazy.reader.readHeadPaths.mockRejectedValue(new Error("corrupt blob"));
    const object = repo();
    const gitAccess = vi.spyOn(object, "gitAccess").mockRejectedValue(new Error("checkout"));

    await expect(object.getFilesSnapshot({ commitOid: PIN })).rejects.toThrow("corrupt blob");
    expect(gitAccess).not.toHaveBeenCalled();
  });
});
