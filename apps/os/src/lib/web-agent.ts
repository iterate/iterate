/** Web-agent creation: fresh agent paths and the first conversational turn. */

import type { AgentMessageAttachment } from "@iterate-com/shared/agent-message-attachments";

export function newWebAgentPath(date: Date) {
  const slug = date
    .toISOString()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `/agents/web/${slug}`;
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

/** The slice of an itx agent handle the first turn touches. */
type WebAgentHandle = {
  create: () => Promise<unknown>;
  message: (input: {
    message: string;
    attachments?: AgentMessageAttachment[];
    files?: Awaited<ReturnType<typeof filesToAgentPayload>>;
  }) => Promise<unknown>;
};

/**
 * Create the agent and send the first turn as one message event. The unified
 * input keeps text, semantic references, and attachments atomic.
 */
export async function sendAgentFirstTurn(
  agent: WebAgentHandle,
  input: {
    message: string;
    attachments?: AgentMessageAttachment[];
    files?: readonly File[];
  },
) {
  await agent.create();
  const files = input.files || [];
  await agent.message({
    message: input.message,
    ...(input.attachments === undefined || input.attachments.length === 0
      ? {}
      : { attachments: input.attachments }),
    ...(files.length === 0 ? {} : { files: await filesToAgentPayload(files) }),
  });
}
