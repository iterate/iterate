import { z } from "zod";

/** Caller must authenticate an operator and reject non-preview environments. */
export async function resetStorageRequest(
  request: Request,
  version: string,
  namespaces: Record<
    string,
    {
      idFromString(id: string): DurableObjectId;
      get(id: DurableObjectId): { resetStorage(): Promise<void> };
    }
  >,
) {
  if (request.method === "GET") {
    return Response.json({ protocol: 1, version, classes: Object.keys(namespaces) });
  }
  if (request.method !== "POST") return new Response("POST required", { status: 405 });
  const input = z
    .object({
      className: z.string(),
      objectId: z.string().regex(/^[a-f0-9]{64}$/),
      version: z.string().min(1),
    })
    .parse(await request.json());
  if (input.version !== version) return new Response("Deployment changed", { status: 409 });
  const namespace = namespaces[input.className];
  if (!namespace) return new Response("Unknown DO class", { status: 400 });
  try {
    await namespace.get(namespace.idFromString(input.objectId)).resetStorage();
  } catch (error) {
    // Abort rejects the RPC. Only the exact post-sync signal proves completion;
    // a deploy interruption or any other transport failure must fail the sweep.
    const completed = z
      .object({
        durableObjectReset: z.literal(true),
        message: z.string().includes("storage reset completed"),
      })
      .safeParse(error);
    if (!completed.success) throw error;
    return Response.json({ reset: true, ...input });
  }
  throw new Error("Storage reset returned without aborting the old instance");
}
