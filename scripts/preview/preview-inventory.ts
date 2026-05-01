export const CLOUDFLARE_PREVIEW_RESOURCE_TYPE = "cloudflare-preview-environment";

export type CloudflarePreviewEnvironmentResourceData = {
  dopplerConfig: string;
};

export type CloudflarePreviewEnvironmentInventoryItem = {
  type: typeof CLOUDFLARE_PREVIEW_RESOURCE_TYPE;
  slug: string;
  data: CloudflarePreviewEnvironmentResourceData;
};

export const cloudflarePreviewEnvironmentInventory = Array.from({ length: 10 }, (_, index) => {
  const slot = index + 1;
  return {
    type: CLOUDFLARE_PREVIEW_RESOURCE_TYPE,
    slug: `preview-${slot}`,
    data: {
      dopplerConfig: `preview_${slot}`,
    },
  };
}) satisfies CloudflarePreviewEnvironmentInventoryItem[];

export type PreviewInventoryClient = {
  add: (input: CloudflarePreviewEnvironmentInventoryItem) => Promise<unknown>;
  delete: (input: { slug: string; type: string }) => Promise<unknown>;
  list: (input: {
    type: string;
  }) => Promise<Array<{ slug: string; data: Record<string, unknown> }>>;
};

export async function syncPreviewInventory(input: {
  client: PreviewInventoryClient;
  inventory?: readonly CloudflarePreviewEnvironmentInventoryItem[];
}) {
  const inventory = input.inventory ?? cloudflarePreviewEnvironmentInventory;
  const expectedBySlug = new Map(inventory.map((resource) => [resource.slug, resource]));
  const existingResources = await input.client.list({ type: CLOUDFLARE_PREVIEW_RESOURCE_TYPE });

  for (const existing of existingResources) {
    const expected = expectedBySlug.get(existing.slug);
    if (expected && isSameResourceData(existing.data, expected.data)) {
      continue;
    }

    await input.client.delete({
      type: CLOUDFLARE_PREVIEW_RESOURCE_TYPE,
      slug: existing.slug,
    });
  }

  const currentResources = await input.client.list({ type: CLOUDFLARE_PREVIEW_RESOURCE_TYPE });
  const currentSlugs = new Set(currentResources.map((resource) => resource.slug));

  for (const resource of inventory) {
    if (currentSlugs.has(resource.slug)) {
      continue;
    }

    await input.client.add(resource);
  }

  return {
    type: CLOUDFLARE_PREVIEW_RESOURCE_TYPE,
    total: inventory.length,
  };
}

export function parsePreviewEnvironmentData(
  data: Record<string, unknown>,
): CloudflarePreviewEnvironmentResourceData {
  if (typeof data.dopplerConfig !== "string" || data.dopplerConfig.trim().length === 0) {
    throw new Error("Preview environment resource data must include dopplerConfig.");
  }

  return {
    dopplerConfig: data.dopplerConfig.trim(),
  };
}

function isSameResourceData(
  left: Record<string, unknown>,
  right: CloudflarePreviewEnvironmentResourceData,
) {
  try {
    const parsed = parsePreviewEnvironmentData(left);
    return parsed.dopplerConfig === right.dopplerConfig && Object.keys(left).length === 1;
  } catch {
    return false;
  }
}
