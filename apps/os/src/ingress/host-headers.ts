export function normalizeIngressHost(host: string) {
  return host.trim().replace(/\.$/, "").toLowerCase();
}
