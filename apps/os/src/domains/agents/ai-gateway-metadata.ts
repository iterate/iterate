import { z } from "zod";
import { StreamContext } from "../projects/stream-context.ts";

const AiGatewayMetadataInput = z.object({
  identity: z.object({
    environment: z.string().min(1),
    projectId: z.string().min(1),
    projectSlug: z.string().min(1),
  }),
  context: z.union([
    StreamContext,
    z.object({
      kind: z.literal("agent-turn"),
      streamPath: z.string().startsWith("/"),
      eventOffset: z.number().int().nonnegative(),
    }),
  ]),
  includeEventOffset: z.boolean(),
});
export type AiGatewayMetadataInput = z.infer<typeof AiGatewayMetadataInput>;

/** Host identity only. JSON encoding omits absent context; zero remains a valid offset. */
export function aiGatewayMetadata(input: AiGatewayMetadataInput) {
  const { identity, context, includeEventOffset } = AiGatewayMetadataInput.parse(input);
  let streamPath: string | undefined;
  let eventOffset: number | undefined;
  switch (context.kind) {
    case "agent-turn":
      streamPath = context.streamPath;
      eventOffset = context.eventOffset;
      break;
    case "script-execution":
      streamPath = context.streamPath;
      eventOffset = context.scriptRunRequestedEventOffset;
      break;
    case "scope":
      streamPath = context.scopePath;
      break;
    case "client-session":
      break;
  }
  return {
    ...identity,
    streamPath,
    eventOffset: includeEventOffset ? eventOffset : undefined,
  } satisfies Record<string, string | number | null | undefined>; // ai gateway metadata doesn't allow nested objects
}

export type AiGatewayMetadata = ReturnType<typeof aiGatewayMetadata>;

/** One reader per DO incarnation. Only the display slug is cached; IDs always come from the host. */
export function createAiGatewayIdentityReader(input: {
  environment: () => string | undefined;
  projectId: string;
  directory: KVNamespace;
}) {
  let cached: { slug: string; expiresAt: number } | undefined;
  return async () => {
    const environment = z.string().min(1).parse(input.environment());
    if (!cached || cached.expiresAt <= Date.now()) {
      // Use the same project-directory record as the rest of OS. A rename is
      // visible within a minute and can never change a budget partition.
      const { readProjectById } = await import("../../project-directory.ts");
      const project = await readProjectById(input.directory, input.projectId);
      if (!project)
        throw new Error(`AI Gateway metadata has no directory record for ${input.projectId}`);
      cached = { slug: project.slug, expiresAt: Date.now() + 60_000 };
    }
    return { environment, projectId: input.projectId, projectSlug: cached.slug };
  };
}
