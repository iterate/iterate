import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSlug } from "../create-slug.ts";

export interface UseTmpDirFixture extends AsyncDisposable {
  path: string;
}

export async function useTmpDir(
  params: {
    prefix?: string;
    testName?: string;
    destroyOnDispose?: boolean;
  } = {},
): Promise<UseTmpDirFixture> {
  /**
   * Typical test usage:
   *
   * ```ts
   * await using tmp = await useTmpDir({
   *   prefix: "provider-contract",
   *   destroyOnDispose: false,
   * });
   *
   * console.log(`artifacts: ${tmp.path}`);
   * ```
   */
  const testLabel = createSlug({
    input: params.testName ?? "unnamed-test",
    maxLength: 24,
  });
  const testId = `${formatTimestamp(new Date())}-${randomUUID().slice(0, 8)}-${testLabel}`;
  const prefix = params.prefix?.trim().length ? params.prefix.trim() : "jonasland-test";
  const path = await mkdtemp(join(tmpdir(), `${prefix}-${testId}-`));

  return {
    path,
    async [Symbol.asyncDispose]() {
      if (params.destroyOnDispose === false) return;
      await rm(path, { recursive: true, force: true });
    },
  };
}

function formatTimestamp(date: Date) {
  const parts = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0"),
  ];
  return `${parts[0]}${parts[1]}${parts[2]}-${parts[3]}${parts[4]}${parts[5]}`;
}
