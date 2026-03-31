export type IngressProxyAppFixture = {
  apiToken: string;
  baseURL: string;
  fetch(pathname: string, init?: RequestInit): Promise<Response>;
  apiFetch(pathname: string, init?: RequestInit): Promise<Response>;
};

export function requireIngressProxyBaseUrl() {
  const value = process.env.INGRESS_PROXY_BASE_URL?.trim();
  if (!value) {
    throw new Error(
      "INGRESS_PROXY_BASE_URL is required for ingress-proxy network e2e tests. Start or deploy the worker outside the test runner, then run the suite with INGRESS_PROXY_BASE_URL=https://... .",
    );
  }

  return value.replace(/\/+$/, "");
}

export function requireIngressProxyApiToken() {
  const overrideValue = process.env.APP_CONFIG_SHARED_API_SECRET?.trim();
  if (overrideValue) {
    return overrideValue;
  }

  const baseConfigValue = process.env.APP_CONFIG?.trim();
  if (baseConfigValue) {
    const parsed = JSON.parse(baseConfigValue) as { sharedApiSecret?: unknown };
    if (typeof parsed.sharedApiSecret === "string" && parsed.sharedApiSecret.trim().length > 0) {
      return parsed.sharedApiSecret.trim();
    }
  }

  const value = process.env.INGRESS_PROXY_API_TOKEN?.trim();
  if (!value) {
    throw new Error(
      "INGRESS_PROXY_API_TOKEN or APP_CONFIG_SHARED_API_SECRET is required for ingress-proxy network e2e tests. Run via `doppler run` or export the token first.",
    );
  }

  return value;
}

export function ingressProxyBaseDomain(baseURL: string) {
  const value = process.env.INGRESS_PROXY_PROXY_BASE_DOMAIN?.trim();
  if (value) {
    return value;
  }

  return new URL(baseURL).host;
}

export function createIngressProxyAppFixture(args: {
  apiToken: string;
  baseURL: string;
}): IngressProxyAppFixture {
  const baseURL = args.baseURL.replace(/\/+$/, "");
  const apiFetch: IngressProxyAppFixture["apiFetch"] = async (pathname, init) => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${args.apiToken}`);
    return fetch(new URL(pathname, baseURL), {
      ...init,
      headers,
    });
  };

  return {
    apiToken: args.apiToken,
    baseURL,
    fetch: (pathname, init) => fetch(new URL(pathname, baseURL), init),
    apiFetch,
  };
}
