import {
  StreamNamespace,
  type StreamNamespace as NamespaceValue,
} from "@iterate-com/shared/streams/types";

export const Namespace = StreamNamespace;
export type { NamespaceValue };

export const defaultNamespace: NamespaceValue = "public";
const appHostLabel = "events";
const iterateEnvironmentLabelPattern = /^iterate(?:-[a-z0-9-]+)?$/;

function getEventsHostBase(hostname: string) {
  const labels = hostname.split(".");

  if (
    labels.length === 3 &&
    labels[0] === appHostLabel &&
    iterateEnvironmentLabelPattern.test(labels[1] ?? "") &&
    labels[2] === "com"
  ) {
    return hostname;
  }

  if (
    labels.length === 4 &&
    labels[1] === appHostLabel &&
    iterateEnvironmentLabelPattern.test(labels[2] ?? "") &&
    labels[3] === "com"
  ) {
    return labels.slice(1).join(".");
  }

  return undefined;
}

export function resolveHostNamespace(hostname: string | null | undefined) {
  const normalizedHostname = hostname?.trim().toLowerCase();
  if (!normalizedHostname) {
    return undefined;
  }

  const labels = normalizedHostname.split(".");
  if (
    labels.length !== 4 ||
    labels[1] !== appHostLabel ||
    !iterateEnvironmentLabelPattern.test(labels[2] ?? "") ||
    labels[3] !== "com"
  ) {
    return undefined;
  }

  const maybeNamespace = labels[0];
  const parsedHostNamespace = Namespace.safeParse(maybeNamespace);
  return parsedHostNamespace.success ? parsedHostNamespace.data : undefined;
}

export function getNamespaceUrl(args: { currentUrl: string | URL; namespace: NamespaceValue }) {
  const url = new URL(args.currentUrl);
  const eventsHostBase = getEventsHostBase(url.hostname);

  if (eventsHostBase) {
    url.hostname =
      args.namespace === defaultNamespace ? eventsHostBase : `${args.namespace}.${eventsHostBase}`;
  }

  return url;
}
