const cloudflareAccountIdPattern = /^[a-f0-9]{32}$/i;
const cloudflareApplicationIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const cloudflareContainerInstanceIdPattern = /^[a-f0-9]{64}$/i;

export type CloudflareContainerDashboardTarget = {
  applicationId: string;
  instanceId: string;
};

export function buildCloudflareContainersDashboardUrl(input: {
  accountId?: string;
  applicationId?: string;
  instanceId?: string;
}) {
  const accountId = input.accountId?.trim();
  if (!accountId || !cloudflareAccountIdPattern.test(accountId)) return null;

  const applicationId = input.applicationId?.trim();
  const instanceId = input.instanceId?.trim();
  let dashboardPath = `/${accountId}/workers/containers`;
  if (
    applicationId &&
    instanceId &&
    cloudflareApplicationIdPattern.test(applicationId) &&
    cloudflareContainerInstanceIdPattern.test(instanceId)
  ) {
    dashboardPath = `/${accountId}/workers/containers/applications/${applicationId}/instances/${instanceId}`;
  }
  const url = new URL("https://dash.cloudflare.com/");
  url.searchParams.set("to", dashboardPath);
  return url.toString();
}

/** Wrangler's default for an unnamed container application is
 * `worker-name-class-name[-env-name]`, lower-cased. OS's preview worker uses
 * hyphens while its Wrangler environment uses an underscore (`preview_5`), so
 * recover the actual environment spelling for the API lookup. */
export function cloudflareContainerApplicationName(input: {
  className: string;
  workerName?: string;
}) {
  const workerName = input.workerName?.trim();
  const className = input.className.trim();
  if (!workerName || !className) return null;

  let environmentName: string | null;
  if (workerName === "os") {
    environmentName = null;
  } else if (workerName === "os-prd") {
    environmentName = "prd";
  } else {
    const preview = /^os-preview-(\d+)$/.exec(workerName);
    if (!preview) return null;
    environmentName = `preview_${preview[1]}`;
  }

  return [workerName, className, environmentName].filter(Boolean).join("-").toLowerCase();
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
