// @ts-nocheck
export function appFetch(appSlug, fetch) {
  return async (request) => {
    const hostname = ingressHostname(request);
    const firstLabel = hostname.split(".")[0] ?? "";
    if (firstLabel !== appSlug && !firstLabel.startsWith(`${appSlug}__`)) return null;

    return await fetch(request);
  };
}

export async function firstResponse(fetchers, request) {
  for (const fetch of fetchers) {
    const response = await fetch(request);
    if (response) return response;
  }

  return null;
}

function ingressHostname(request) {
  return request.headers.get("x-iterate-ingress-hostname") ?? new URL(request.url).hostname;
}
