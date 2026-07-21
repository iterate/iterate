/**
 * Cloudflare can briefly route requests to the previous Worker after a
 * `wrangler deploy` has completed. That is especially destructive for Vite
 * applications: old HTML can name assets that the new deployment no longer
 * serves. Preview CI carries Wrangler's immutable version IDs through this
 * environment variable and pins every test request to the deployment it is
 * proving.
 *
 * https://developers.cloudflare.com/workers/versions-and-deployments/version-overrides/
 */
export const E2E_CLOUDFLARE_WORKERS_VERSION_OVERRIDES_ENV =
  "E2E_CLOUDFLARE_WORKERS_VERSION_OVERRIDES";
export const CLOUDFLARE_WORKERS_VERSION_OVERRIDES_HEADER = "Cloudflare-Workers-Version-Overrides";

export type CloudflareWorkerVersionOverride = {
  versionId: string;
  workerName: string;
};

const structuredDictionaryKeyPattern = /^[a-z*][a-z0-9_.*-]*$/;
const workerVersionIdPattern = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

/** Render the exact RFC 8941 dictionary shape Cloudflare accepts. */
export function renderCloudflareWorkerVersionOverrides(
  overrides: readonly CloudflareWorkerVersionOverride[],
): string {
  if (overrides.length === 0) {
    throw new Error("At least one Cloudflare Worker version override is required.");
  }

  const byWorkerName = new Map<string, string>();
  for (const override of overrides) {
    if (!structuredDictionaryKeyPattern.test(override.workerName)) {
      throw new Error(
        `Cloudflare Worker name ${JSON.stringify(override.workerName)} is not a valid Structured Fields dictionary key.`,
      );
    }
    if (!workerVersionIdPattern.test(override.versionId)) {
      throw new Error(
        `Cloudflare Worker version ${JSON.stringify(override.versionId)} is not a UUID.`,
      );
    }
    if (byWorkerName.has(override.workerName)) {
      throw new Error(
        `Cloudflare Worker ${JSON.stringify(override.workerName)} has more than one version override.`,
      );
    }
    byWorkerName.set(override.workerName, override.versionId);
  }

  return [...byWorkerName]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([workerName, versionId]) => `${workerName}="${versionId}"`)
    .join(",");
}

/**
 * Resolve the one test-only header from an explicit environment. An absent
 * value means local development and produces no header; a malformed non-empty
 * value is a harness defect and fails rather than silently losing the pin.
 */
export function cloudflareWorkerVersionOverrideHeaders(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const value = environment[E2E_CLOUDFLARE_WORKERS_VERSION_OVERRIDES_ENV]?.trim();
  if (!value) return {};

  const entries = value.split(",");
  if (
    entries.some(
      (entry) =>
        !/^([a-z*][a-z0-9_.*-]*)="([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})"$/i.test(
          entry,
        ),
    )
  ) {
    throw new Error(
      `${E2E_CLOUDFLARE_WORKERS_VERSION_OVERRIDES_ENV} is not an exact Worker version override dictionary.`,
    );
  }

  return { [CLOUDFLARE_WORKERS_VERSION_OVERRIDES_HEADER]: value };
}

/** Add the preview pin without dropping a request's auth/content headers. */
export function mergeCloudflareWorkerVersionOverrideHeaders(
  initial: ConstructorParameters<typeof Headers>[0] | undefined,
  environment: Readonly<Record<string, string | undefined>>,
): Headers {
  const headers = new Headers(initial);
  for (const [name, value] of Object.entries(cloudflareWorkerVersionOverrideHeaders(environment))) {
    headers.set(name, value);
  }
  return headers;
}

/** Wrap fetch once at a test boundary so Request and init headers both survive. */
export function createCloudflareWorkerVersionOverrideFetch(
  fetchImplementation: typeof fetch,
  environment: Readonly<Record<string, string | undefined>>,
): typeof fetch {
  const versionHeaders = cloudflareWorkerVersionOverrideHeaders(environment);
  if (Object.keys(versionHeaders).length === 0) return fetchImplementation;

  return (input, init) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    for (const [name, value] of Object.entries(versionHeaders)) headers.set(name, value);
    return fetchImplementation(input, { ...init, headers });
  };
}
