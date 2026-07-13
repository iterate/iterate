/**
 * Tiny, application-independent context sent beside each Cap'n Web call.
 *
 * One connection ID groups calls made over the same long-lived WebSocket. A
 * fresh call ID identifies the logical RPC within that connection. This is
 * protocol metadata, not a method argument, so adding observability never
 * changes the public itx contract.
 */
export type ItxCallMetadata = {
  version: 1;
  callId: string;
  connectionId: string;
  client: "browser" | "node";
  projectId?: string;
};

type ItxClientObservabilityInput = Pick<ItxCallMetadata, "client" | "projectId">;

export function createItxClientObservability(input: ItxClientObservabilityInput) {
  const connectionId = crypto.randomUUID();

  return {
    connectionId,
    getCallMetadata: (): ItxCallMetadata => ({
      version: 1,
      callId: crypto.randomUUID(),
      connectionId,
      client: input.client,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    }),
  };
}

const MAX_IDENTIFIER_LENGTH = 128;

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH;
}

/** Treat all peer-supplied observability metadata as untrusted wire input. */
export function parseItxCallMetadata(value: unknown): ItxCallMetadata | undefined {
  if (typeof value !== "object" || value === null) return undefined;

  const candidate = value as Partial<Record<keyof ItxCallMetadata, unknown>>;
  if (
    candidate.version !== 1 ||
    !isIdentifier(candidate.callId) ||
    !isIdentifier(candidate.connectionId) ||
    (candidate.client !== "browser" && candidate.client !== "node") ||
    (candidate.projectId !== undefined && !isIdentifier(candidate.projectId))
  ) {
    return undefined;
  }

  return {
    version: 1,
    callId: candidate.callId,
    connectionId: candidate.connectionId,
    client: candidate.client,
    ...(candidate.projectId === undefined ? {} : { projectId: candidate.projectId }),
  };
}
