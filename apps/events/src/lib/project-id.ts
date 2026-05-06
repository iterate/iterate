import { ProjectId, type ProjectId as ProjectIdValue } from "@iterate-com/shared/streams/types";

export const defaultProjectId: ProjectIdValue = "public";
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

export function resolveHostProjectId(hostname: string | null | undefined) {
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

  const maybeProjectId = labels[0];
  const parsedHostProjectId = ProjectId.safeParse(maybeProjectId);
  return parsedHostProjectId.success ? parsedHostProjectId.data : undefined;
}

export function getProjectUrl(args: { currentUrl: string | URL; projectId: ProjectIdValue }) {
  const url = new URL(args.currentUrl);
  const eventsHostBase = getEventsHostBase(url.hostname);

  if (eventsHostBase) {
    url.hostname =
      args.projectId === defaultProjectId ? eventsHostBase : `${args.projectId}.${eventsHostBase}`;
  }

  return url;
}
