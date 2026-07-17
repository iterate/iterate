import type { Plugin } from "vite";

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Wrangler normalizes the public `containers.ssh` field to its Containers API
 * name, `wrangler_ssh`. The Cloudflare Vite plugin currently serializes that
 * normalized object into its deploy artifact, where Wrangler correctly warns
 * that the internal name is deprecated. Restore the public spelling without
 * changing the value that will be deployed.
 */
export function canonicalizeContainerSsh(config: unknown): unknown {
  if (!isJsonObject(config)) throw new Error("Built Wrangler config must be a JSON object.");

  const { containers } = config;
  if (containers === undefined) return config;
  if (!Array.isArray(containers)) {
    throw new Error("Built Wrangler config containers must be an array.");
  }

  let changed = false;
  const canonicalContainers = containers.map((container, index) => {
    if (!isJsonObject(container)) {
      throw new Error(`Built Wrangler config containers[${index}] must be a JSON object.`);
    }
    if (!Object.hasOwn(container, "wrangler_ssh")) return container;
    if (Object.hasOwn(container, "ssh")) {
      throw new Error(
        `Built Wrangler config containers[${index}] contains both ssh and wrangler_ssh.`,
      );
    }

    const { wrangler_ssh, ...canonicalContainer } = container;
    changed = true;
    return { ...canonicalContainer, ssh: wrangler_ssh };
  });

  return changed ? { ...config, containers: canonicalContainers } : config;
}

/** Canonicalize the Cloudflare Vite plugin's generated wrangler.json asset. */
export function canonicalizeOutputWranglerConfig(): Plugin {
  return {
    name: "iterate:canonicalize-output-wrangler-config",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const outputConfig = bundle["wrangler.json"];
      if (outputConfig === undefined) return;
      if (outputConfig.type !== "asset" || typeof outputConfig.source !== "string") {
        throw new Error("Expected the generated wrangler.json to be a string asset.");
      }

      outputConfig.source = JSON.stringify(
        canonicalizeContainerSsh(JSON.parse(outputConfig.source) as unknown),
      );
    },
  };
}
