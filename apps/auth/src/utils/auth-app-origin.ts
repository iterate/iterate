declare const __AUTH_APP_ORIGIN__: string | undefined;

export function getAuthAppOrigin() {
  if (typeof __AUTH_APP_ORIGIN__ === "string" && __AUTH_APP_ORIGIN__.trim()) {
    return __AUTH_APP_ORIGIN__.trim();
  }

  if (typeof window !== "undefined") {
    return window.location.origin;
  }

  throw new Error("APP_CONFIG_AUTH_APP_ORIGIN is required for server-side auth requests.");
}
