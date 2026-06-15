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
  return parseProjectPlatformHosts(input)[0] ?? null;
}

export function parseProjectPlatformHosts(input: {
  bases: readonly string[];
  host: string;
}): ParsedProjectPlatformHost[] {
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
      if (!appSlug || !projectIdentifier) return [];
      return [{ appSlug, projectIdentifier }];
    }
  }

  return [];
}

function parseSingleLabelPlatformPrefix(prefix: string): ParsedProjectPlatformHost[] {
  if (!prefix) return [];

  const separatorIndex = prefix.indexOf("__");
  if (separatorIndex === -1) return [{ appSlug: null, projectIdentifier: prefix }];
  if (separatorIndex === 0) return [];

  const appSlug = prefix.slice(0, separatorIndex);
  const projectIdentifier = prefix.slice(separatorIndex + 2);
  if (!appSlug || !projectIdentifier) return [];
  return [
    { appSlug: null, projectIdentifier: prefix },
    { appSlug, projectIdentifier },
  ];
}
