const cloudflareAccountIdPattern = /^[a-f0-9]{32}$/i;

export function buildCloudflareContainersDashboardUrl(input: { accountId?: string }) {
  const accountId = input.accountId?.trim();
  if (!accountId || !cloudflareAccountIdPattern.test(accountId)) return null;

  const url = new URL("https://dash.cloudflare.com/");
  url.searchParams.set("to", `/${accountId}/workers/containers`);
  return url.toString();
}

export function inferOsDopplerConfigForWorkerName(workerName?: string) {
  const name = workerName?.trim();
  if (!name) return "<env>";
  if (name === "os") return "dev";
  if (name === "os-prd") return "prd";

  const preview = /^os-preview-(\d+)$/.exec(name);
  if (preview) return `preview_${preview[1]}`;

  return "<env>";
}
