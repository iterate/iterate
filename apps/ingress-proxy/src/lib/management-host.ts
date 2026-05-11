export function isManagementHost(input: { baseUrl: string | undefined; host: string | null }) {
  if (!input.host) return true;

  const configuredBaseHost = input.baseUrl ? new URL(input.baseUrl).hostname : null;
  if (configuredBaseHost && input.host === configuredBaseHost) return true;

  return (
    input.host === "localhost" ||
    input.host === "127.0.0.1" ||
    input.host === "::1" ||
    input.host === "ingress.iterate.com" ||
    input.host === "dev-placeholder.ingress.iterate.com" ||
    input.host.endsWith(".workers.dev")
  );
}
