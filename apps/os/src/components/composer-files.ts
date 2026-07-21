/** Shared attachment limits and helpers for chat + new-agent composers. */

import { formatFileSize } from "~/lib/feed-format.ts";

export { formatFileSize };

export const MAX_MESSAGE_FILE_SIZE_BYTES = 25 * 1024 * 1024;

export function partitionFilesBySize(
  files: readonly File[],
  maxBytes: number = MAX_MESSAGE_FILE_SIZE_BYTES,
): { accepted: File[]; rejected: File[] } {
  const accepted: File[] = [];
  const rejected: File[] = [];
  for (const file of files) {
    if (file.size <= maxBytes) accepted.push(file);
    else rejected.push(file);
  }
  return { accepted, rejected };
}

export function fileSizeErrorMessage(
  rejected: readonly File[],
  maxBytes: number = MAX_MESSAGE_FILE_SIZE_BYTES,
): string | undefined {
  if (rejected.length === 0) return undefined;
  const label = rejected.length === 1 ? rejected[0]!.name : `${rejected.length} files`;
  return `${label} must be ${formatFileSize(maxBytes)} or smaller.`;
}

/** Encode browser Files for `agent.addFiles`. */
export async function filesToAgentPayload(files: readonly File[]) {
  return Promise.all(
    files.map(async (file) => ({
      contentType: file.type || "application/octet-stream",
      data: new Uint8Array(await file.arrayBuffer()),
      filename: file.name,
    })),
  );
}

export function slugifyCreationTime(date: Date) {
  return date
    .toISOString()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function newWebAgentPath(date: Date = new Date()) {
  return `/agents/web/${slugifyCreationTime(date)}`;
}

/**
 * Create a web agent and send the first turn: files use `addFiles` (same path
 * as the chat composer); text-only uses `message`.
 */
export async function createAgentWithFirstTurn(input: {
  projectId: string;
  connectItx: (projectId: string) => Promise<{
    agents: {
      get: (path: string) => {
        create: () => Promise<unknown>;
        message: (content: string) => Promise<unknown>;
        addFiles: (input: {
          files: Awaited<ReturnType<typeof filesToAgentPayload>>;
          message?: string;
        }) => Promise<unknown>;
      };
    };
  }>;
  message: string;
  files?: readonly File[];
  now?: Date;
}): Promise<string> {
  const agentPath = newWebAgentPath(input.now ?? new Date());
  const itx = await input.connectItx(input.projectId);
  const agent = itx.agents.get(agentPath);
  await agent.create();
  const files = input.files ?? [];
  const trimmed = input.message.trim();
  if (files.length > 0) {
    await agent.addFiles({
      files: await filesToAgentPayload(files),
      ...(trimmed ? { message: trimmed } : {}),
    });
  } else {
    await agent.message(trimmed);
  }
  return agentPath;
}
