export const ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE = "environment-config-lease";

export type EnvironmentConfigLeaseResourceData = {
  dopplerConfig: string;
};

export type EnvironmentConfigLeaseInventoryItem = {
  type: typeof ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE;
  slug: string;
  data: EnvironmentConfigLeaseResourceData;
};

// This is the deliberate seed used when recreating the Semaphore inventory.
// The live Semaphore database remains the source of truth for deploys.
const seededPreviewEnvironmentNumbers = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

export const environmentConfigLeaseInventory = seededPreviewEnvironmentNumbers.map(
  (leaseNumber) => {
    return {
      type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
      slug: `preview-${leaseNumber}`,
      data: {
        dopplerConfig: `preview_${leaseNumber}`,
      },
    };
  },
) satisfies EnvironmentConfigLeaseInventoryItem[];

export type PreviewInventoryClient = {
  add: (input: EnvironmentConfigLeaseInventoryItem) => Promise<unknown>;
  delete: (input: { slug: string; type: string }) => Promise<unknown>;
  list: (input: {
    type: string;
  }) => Promise<Array<{ slug: string; data: Record<string, unknown> }>>;
};

export async function syncPreviewInventory(input: {
  client: PreviewInventoryClient;
  inventory?: readonly EnvironmentConfigLeaseInventoryItem[];
}) {
  const inventory = input.inventory ?? environmentConfigLeaseInventory;
  const expectedBySlug = new Map(inventory.map((resource) => [resource.slug, resource]));
  const existingResources = await input.client.list({
    type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
  });

  for (const existing of existingResources) {
    const expected = expectedBySlug.get(existing.slug);
    if (expected && isSameResourceData(existing.data, expected.data)) {
      continue;
    }

    await input.client.delete({
      type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
      slug: existing.slug,
    });
  }

  const currentResources = await input.client.list({
    type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
  });
  const currentSlugs = new Set(currentResources.map((resource) => resource.slug));

  for (const resource of inventory) {
    if (currentSlugs.has(resource.slug)) {
      continue;
    }

    await input.client.add(resource);
  }

  return {
    type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
    total: inventory.length,
  };
}

export function parseEnvironmentConfigLeaseData(
  data: Record<string, unknown>,
): EnvironmentConfigLeaseResourceData {
  if (typeof data.dopplerConfig !== "string" || data.dopplerConfig.trim().length === 0) {
    throw new Error("Environment config lease data must include dopplerConfig.");
  }

  return {
    dopplerConfig: data.dopplerConfig.trim(),
  };
}

function isSameResourceData(
  left: Record<string, unknown>,
  right: EnvironmentConfigLeaseResourceData,
) {
  try {
    const parsed = parseEnvironmentConfigLeaseData(left);
    return parsed.dopplerConfig === right.dopplerConfig && Object.keys(left).length === 1;
  } catch {
    return false;
  }
}
