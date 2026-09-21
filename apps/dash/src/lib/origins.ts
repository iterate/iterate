/** `value` as an http(s) origin, or null. What the issuer's `info()` reports — its platform and MCP
 *  origins — becomes an href or a copyable command only once parsed: a value that is not a URL, or
 *  not http(s) (`javascript:`), goes nowhere. */
export function httpOriginOf(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
}
