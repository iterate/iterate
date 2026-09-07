import { z } from "zod";

export const AiCostAttribution = z.object({
  environment: z.string().min(1),
  projectId: z.string().min(1),
  projectSlug: z.string().min(1),
  stream: z
    .object({
      path: z.string().startsWith("/"),
      eventOffset: z.number().int().nonnegative().optional(),
    })
    .nullable(),
});
export type AiCostAttribution = z.infer<typeof AiCostAttribution>;

/** Host identity only. JSON encoding omits absent context; zero remains a valid offset. */
export function aiGatewayMetadata(attribution: AiCostAttribution, includeEventOffset: boolean) {
  const value = AiCostAttribution.parse(attribution);
  return {
    environment: value.environment,
    projectId: value.projectId,
    projectSlug: value.projectSlug,
    streamPath: value.stream?.path,
    eventOffset: includeEventOffset ? value.stream?.eventOffset : undefined,
  };
}
export type AiGatewayMetadata = ReturnType<typeof aiGatewayMetadata>;

/** One reader per DO incarnation. Only the display slug is cached; IDs always come from the host. */
export function createAiCostIdentityReader(input: {
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
        throw new Error(`AI cost attribution has no directory record for ${input.projectId}`);
      cached = { slug: project.slug, expiresAt: Date.now() + 60_000 };
    }
    return { environment, projectId: input.projectId, projectSlug: cached.slug };
  };
}
