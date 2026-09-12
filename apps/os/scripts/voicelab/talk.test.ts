import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveKitDir } from "./talk.ts";

afterEach(() => vi.unstubAllEnvs());

describe("firmware checkout selection", () => {
  it("uses this checkout by default", () => {
    vi.stubEnv("ITERATE_KIT_DIR", "");
    expect(resolveKitDir()).toBe(fileURLToPath(new URL("../../../kit", import.meta.url)));
  });

  it("rejects a missing explicit checkout instead of building another checkout", () => {
    const missing = `/tmp/iterate-kit-missing-${crypto.randomUUID()}`;
    vi.stubEnv("ITERATE_KIT_DIR", resolveKitDir());
    expect(() => resolveKitDir(missing)).toThrow(`No firmware/CMakeLists.txt in ${missing}`);
  });

  it("rejects a missing environment checkout instead of using the default", () => {
    const missing = `/tmp/iterate-kit-missing-${crypto.randomUUID()}`;
    vi.stubEnv("ITERATE_KIT_DIR", missing);
    expect(() => resolveKitDir()).toThrow(`No firmware/CMakeLists.txt in ${missing}`);
  });
});
