/** Web-agent creation: fresh agent paths and the first conversational turn. */

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
  message: (content: string) => Promise<unknown>;
  addFiles: (input: {
    files: Awaited<ReturnType<typeof filesToAgentPayload>>;
    message?: string;
  }) => Promise<unknown>;
};

/**
 * Create the agent and send the first turn. Files go through `addFiles` (same
 * path as the chat composer — ONE input event, one turn trigger); text-only
 * uses `message`.
 */
export async function sendAgentFirstTurn(
  agent: WebAgentHandle,
  input: { message: string; files?: readonly File[] },
) {
  await agent.create();
  const files = input.files || [];
  const trimmed = input.message.trim();
  if (files.length) {
    await agent.addFiles({
      files: await filesToAgentPayload(files),
      ...(trimmed && { message: trimmed }),
    });
  } else {
    await agent.message(trimmed);
  }
}
