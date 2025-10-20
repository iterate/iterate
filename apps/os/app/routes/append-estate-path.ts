export function appendEstatePath(redirectPath: string, estatePath: string) {
  try {
    const redirectPathURL = new URL(redirectPath, "http://estate");
    const tempURL = new URL(estatePath, "http://estate");
    // check that there's no sneaky stuff like //evil.com
    if (tempURL.origin === "http://estate") {
      redirectPathURL.pathname += tempURL.pathname;
      for (const [key, value] of tempURL.searchParams.entries()) {
        redirectPathURL.searchParams.set(key, value);
      }
      return redirectPathURL.toString().replace(redirectPathURL.origin, "");
    }
  } catch {
    // sus path(s), don't append
  }
  return redirectPath;
}
