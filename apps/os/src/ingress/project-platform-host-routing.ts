import { normalizeIngressHost } from "./host-headers.ts";
import { normalizeProjectHostnameBase } from "~/lib/project-host-routing.ts";

type ParsedProjectPlatformHost = {
  appSlug: string | null;
  projectIdentifier: string;
};

export function parseProjectPlatformHost(input: {
  bases: readonly string[];
  host: string;
}): ParsedProjectPlatformHost | null {
  const host = normalizeIngressHost(input.host);

  for (const rawBase of input.bases) {
    const base = normalizeIngressHost(normalizeProjectHostnameBase(rawBase));
    if (host === base || !host.endsWith(`.${base}`)) continue;

    const prefix = host.slice(0, host.length - base.length - 1);
    const labels = prefix.split(".").filter(Boolean);
    if (labels.length === 1) {
      return parseSingleLabelPlatformPrefix(labels[0] ?? "");
    }
    if (labels.length === 2) {
      const [appSlug, projectIdentifier] = labels;
      if (!appSlug || !projectIdentifier) return null;
      return { appSlug, projectIdentifier };
    }
  }

  return null;
}

function parseSingleLabelPlatformPrefix(prefix: string): ParsedProjectPlatformHost | null {
  if (!prefix) return null;

  // `--` is the reserved, unambiguous app/project separator. Project slugs
  // are produced by slugify(), which collapses consecutive hyphens, so a
  // canonical app host must never incur a speculative whole-label lookup.
  const separator = "--";
  const separatorIndex = prefix.indexOf(separator);
  if (separatorIndex >= 0) {
    const appSlug = prefix.slice(0, separatorIndex);
    const projectIdentifier = prefix.slice(separatorIndex + separator.length);
    if (!appSlug || !projectIdentifier) return null;
    return { appSlug, projectIdentifier };
  }

  return { appSlug: null, projectIdentifier: prefix };
}
