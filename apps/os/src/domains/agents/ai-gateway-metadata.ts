import { z } from "zod";
import { StreamContext } from "../projects/stream-context.ts";

const AiGatewayMetadataInput = z.object({
  environment: z.string().min(1),
  projectId: z.string().min(1),
  context: StreamContext,
});
type AiGatewayMetadataInput = z.infer<typeof AiGatewayMetadataInput>;

/** Host identity only. JSON encoding omits absent context; zero remains a valid offset. */
export function aiGatewayMetadata(input: AiGatewayMetadataInput) {
  const { environment, projectId, context } = AiGatewayMetadataInput.parse(input);
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
    environment,
    projectId,
    streamPath,
    eventOffset,
  } satisfies Record<string, string | number | null | undefined>; // ai gateway metadata doesn't allow nested objects
}

export type AiGatewayMetadata = ReturnType<typeof aiGatewayMetadata>;
