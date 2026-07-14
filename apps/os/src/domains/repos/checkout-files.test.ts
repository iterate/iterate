import { InMemoryFs } from "@cloudflare/shell";
import { describe, expect, it } from "vitest";
import { readCheckoutBytes, readCheckoutFiles, walkCheckoutPaths } from "./checkout-files.ts";

describe("checkout files", () => {
  it("preserves a dangling symlink as a Git blob instead of dereferencing it", async () => {
    const filesystem = new InMemoryFs();
    await filesystem.mkdir("/repo/nested", { recursive: true });
    await filesystem.writeFile("/repo/nested/file.txt", "hello");
    await filesystem.symlink("../../missing/skill", "/repo/dangling-link");

    await expect(walkCheckoutPaths(filesystem, "/repo")).resolves.toEqual([
      "dangling-link",
      "nested/file.txt",
    ]);
    await expect(readCheckoutFiles(filesystem, "/repo")).resolves.toEqual({
      "dangling-link": "../../missing/skill",
      "nested/file.txt": "hello",
    });
    const bytes = await readCheckoutBytes(filesystem, "/repo");
    expect(new TextDecoder().decode(bytes.get("dangling-link"))).toBe("../../missing/skill");
  });
});
