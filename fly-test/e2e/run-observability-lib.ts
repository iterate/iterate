export function proxyHostForIp(ip: string): string {
  if (ip.includes(":")) return `[${ip}]`;
  return ip;
}

export function hostFromUrl(url: string): string {
  const parsed = new URL(url);
  return parsed.host;
}

export function urlEncodedForm(data: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) params.set(key, value);
  return params.toString();
}
