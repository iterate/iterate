/** Web-agent creation: fresh agent paths and the first conversational turn. */

import type { AgentRichContentV1 } from "@iterate-com/shared/agent-rich-content";

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
    files?: Awaited<ReturnType<typeof filesToAgentPayload>>;
    richContent?: AgentRichContentV1;
  }) => Promise<unknown>;
};

/**
 * Create the agent and send the first turn as one message event. The unified
 * input keeps text, semantic references, and attachments atomic.
 */
export async function sendAgentFirstTurn(
  agent: WebAgentHandle,
  input: { message: string; files?: readonly File[]; richContent?: AgentRichContentV1 },
) {
  await agent.create();
  const files = input.files || [];
  await agent.message({
    message: input.message,
    ...(files.length === 0 ? {} : { files: await filesToAgentPayload(files) }),
    ...(input.richContent === undefined ? {} : { richContent: input.richContent }),
  });
}
