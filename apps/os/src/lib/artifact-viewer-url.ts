const artifactNamePattern = /^[a-z0-9][a-z0-9._-]*$/i;

export function buildArtifactViewerUrl(input: { appBaseUrl?: string; artifactName: string }) {
  if (!artifactNamePattern.test(input.artifactName)) return null;
  if (!input.appBaseUrl) return null;

  let url: URL;
  try {
    url = new URL(input.appBaseUrl);
  } catch {
    return null;
  }

  const hostname = artifactViewerHostname(url.hostname);
  if (!hostname) return null;

  url.hostname = hostname;
  url.pathname = `/${input.artifactName}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function artifactViewerHostname(appHostname: string) {
  const labels = appHostname.split(".");
  if (labels.length < 2) return `os-artifacts.${appHostname}`;

  labels[0] = "os-artifacts";
  return labels.join(".");
}
