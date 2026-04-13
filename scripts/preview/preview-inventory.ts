export const DEFAULT_PREVIEW_RESOURCE_COUNT = 10;

export type PreviewInventoryClient = {
  add: (input: { slug: string; type: string }) => Promise<unknown>;
  list: (input: { type: string }) => Promise<Array<{ slug: string }>>;
};

export async function ensurePreviewInventory(input: {
  appSlug: string;
  client: PreviewInventoryClient;
  count?: number;
  type: string;
}) {
  const existingResources = await input.client.list({ type: input.type });
  const existingSlugs = new Set(existingResources.map((resource) => resource.slug));
  const count = input.count ?? DEFAULT_PREVIEW_RESOURCE_COUNT;

  for (let slot = 1; slot <= count; slot += 1) {
    const slug = `${input.appSlug}-preview-${slot}`;
    if (existingSlugs.has(slug)) {
      continue;
    }

    try {
      await input.client.add({
        slug,
        type: input.type,
      });
      existingSlugs.add(slug);
    } catch (error) {
      if (!isPreviewInventoryConflictError(error)) {
        throw error;
      }
    }
  }
}

export function isPreviewInventoryConflictError(error: unknown) {
  return (
    error instanceof Error &&
    /Resource already exists for this type and slug|Cannot add a resource while an older lease is still active for this slug/i.test(
      error.message,
    )
  );
}
