import { normalizeIngressHost } from "./host-headers.ts";
import { normalizeProjectHostnameBase } from "~/lib/project-host-routing.ts";

type ParsedProjectPlatformHost = {
  appSlug: string | null;
  projectIdentifier: string;
};

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

  // `<app>--<project>` (canonical) and the older `<app>__<project>` both
  // select an app inside a project from a single hostname label. The bare
  // label stays a candidate too: a project slug may legitimately contain
  // the separator.
  for (const separator of ["--", "__"]) {
    const separatorIndex = prefix.indexOf(separator);
    if (separatorIndex <= 0) continue;

    const appSlug = prefix.slice(0, separatorIndex);
    const projectIdentifier = prefix.slice(separatorIndex + separator.length);
    if (!appSlug || !projectIdentifier) continue;
    return [
      { appSlug: null, projectIdentifier: prefix },
      { appSlug, projectIdentifier },
    ];
  }

  return [{ appSlug: null, projectIdentifier: prefix }];
}
