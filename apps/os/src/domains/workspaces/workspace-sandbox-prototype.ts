/** Throwaway experiment: metadata travels upfront; file bytes travel on demand. */
import { createHash } from "node:crypto";
import { z } from "zod";

export const PrototypeRelativePath = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.includes("\\") &&
      !path.includes("\0") &&
      path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "Expected a relative path without empty, dot, or parent segments",
  );

export const PrototypeWorkspaceExecInput = z.object({
  workspacePath: z.string().startsWith("/"),
  under: z.string().startsWith("/"),
  command: z.string(),
  localDirectories: z.array(PrototypeRelativePath),
  timeoutMs: z.number().int().min(1).max(600_000),
});
export type PrototypeWorkspaceExecInput = z.infer<typeof PrototypeWorkspaceExecInput>;

export const PrototypeReadMetrics = z.object({
  fileReads: z.number().int().nonnegative(),
  readBytes: z.number().int().nonnegative(),
});

export interface PrototypeWorkspaceFile {
  path: string;
  mode: string;
  size: number;
  version: string;
  /** Present only for an unchanged committed file; private/live overlays clear it. */
  repoPath?: string;
  readToken?: string;
}

/** Git blob IDs work for both the committed base and the private overlay. */
export function prototypeFileVersion(bytes: Uint8Array): string {
  return `git:${createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex")}`;
}
