import type { FormEvent, ReactNode } from "react";
import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { CopyIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import { Input } from "@iterate-com/ui/components/input";
import { toast } from "@iterate-com/ui/components/sonner";
import { ProjectHostnameCard } from "~/components/project-hostname-card.tsx";
import {
  addProjectCustomDomainServerFn,
  refreshProjectCustomDomainServerFn,
  removeProjectCustomDomainServerFn,
} from "~/domains/projects/custom-domain-server-fns.ts";
import {
  buildProjectWorkerUrl,
  isValidCustomHostname,
  normalizeProjectHostnameBase,
} from "~/lib/project-host-routing.ts";
import type { PublicRouteConfig } from "~/lib/public-route-config.ts";
import type { ProjectCustomDomain, ProjectProcessorState } from "~/types.ts";

export function ProjectCustomDomainsSettings({
  projectId,
  projectSlug,
  projectState,
  routeConfig,
}: {
  projectId: string;
  projectSlug: string;
  projectState?: ProjectProcessorState;
  routeConfig: PublicRouteConfig;
}) {
  const base = normalizeProjectHostnameBase(routeConfig.projectHostnameBases[0] ?? "");
  const customDomains = projectState?.customDomains;
  const primaryCustomHostname = primaryActiveCustomDomainHostname(customDomains);
  const customDomainWorkerUrl = buildProjectWorkerUrl({
    appBaseUrl: routeConfig.baseUrl,
    customHostname: primaryCustomHostname,
    projectHostnameBases: routeConfig.projectHostnameBases,
    projectSlug,
  });

  return (
    <section className="flex flex-col gap-3" data-testid="project-custom-domains-settings">
      <h2 className="text-xs font-medium text-muted-foreground uppercase">Custom domains</h2>
      <div className="flex flex-col divide-y">
        {primaryCustomHostname ? (
          <SettingsField label="Project homepage">
            <ProjectHostnameCard
              copyLabel="Copy custom domain"
              description="Active custom-domain homepage"
              hostname={primaryCustomHostname}
              openLabel="Open project homepage"
              url={customDomainWorkerUrl}
            />
          </SettingsField>
        ) : null}
        <SettingsField label="DNS setup">
          <CustomDomainsEditor
            domains={customDomains}
            projectId={projectId}
            projectHostnameBase={base}
          />
        </SettingsField>
      </div>
    </section>
  );
}

function CustomDomainsEditor({
  domains,
  projectHostnameBase,
  projectId,
}: {
  domains?: ProjectCustomDomain[];
  projectHostnameBase: string;
  projectId: string;
}) {
  const [hostname, setHostname] = useState("");
  const cnameTarget = isValidCustomHostname(projectHostnameBase)
    ? `cname.${projectHostnameBase}`
    : null;
  const existingHostnames = useMemo(
    () => new Set((domains ?? []).map((domain) => domain.hostname)),
    [domains],
  );
  const addDomain = useMutation({
    mutationFn: async (domainHostname: string) => {
      const result = await addProjectCustomDomainServerFn({
        data: { hostname: domainHostname, projectId },
      });
      return result.hostname;
    },
    onSuccess: async (addedHostname) => {
      setHostname("");
      toast.success(`Custom domain queued: ${addedHostname}`);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });
  const refreshDomain = useMutation({
    mutationFn: async (domainHostname: string) => {
      const result = await refreshProjectCustomDomainServerFn({
        data: { hostname: domainHostname, projectId },
      });
      return result.hostname;
    },
    onSuccess: async (refreshedHostname) => {
      toast.success(`Refresh queued: ${refreshedHostname}`);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });
  const removeDomain = useMutation({
    mutationFn: async (domainHostname: string) => {
      if (!existingHostnames.has(domainHostname)) {
        throw new Error(`Custom domain "${domainHostname}" is not configured on this project.`);
      }
      const result = await removeProjectCustomDomainServerFn({
        data: { hostname: domainHostname, projectId },
      });
      return result.hostname;
    },
    onSuccess: async (removedHostname) => {
      toast.success(`Removal queued: ${removedHostname}`);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = hostname.trim().toLowerCase();
    if (!trimmed || existingHostnames.has(trimmed) || !cnameTarget) return;
    addDomain.mutate(trimmed);
  };

  return (
    <div className="grid gap-3">
      <form className="flex min-w-0 gap-2" onSubmit={onSubmit}>
        <Input
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          disabled={addDomain.isPending || !cnameTarget}
          onChange={(event) => setHostname(event.currentTarget.value)}
          placeholder="garple.com"
          spellCheck={false}
          value={hostname}
        />
        <Button
          aria-label="Add custom domain"
          disabled={addDomain.isPending || !hostname.trim() || !cnameTarget}
          size="icon"
          type="submit"
        >
          <PlusIcon aria-hidden="true" />
        </Button>
      </form>

      {!cnameTarget ? (
        <p className="text-xs text-muted-foreground">
          Custom domains require a deployed DNS project hostname base.
        </p>
      ) : domains === undefined ? (
        <p className="text-xs text-muted-foreground">Loading custom domains...</p>
      ) : domains.length === 0 ? (
        <p className="text-xs text-muted-foreground">No custom domains configured.</p>
      ) : (
        <div className="divide-y rounded-md border">
          {domains.map((domain) => (
            <CustomDomainRow
              domain={domain}
              key={domain.hostname}
              onRefresh={() => refreshDomain.mutate(domain.hostname)}
              onRemove={() => removeDomain.mutate(domain.hostname)}
              cnameTarget={cnameTarget}
              refreshPending={
                refreshDomain.isPending && refreshDomain.variables === domain.hostname
              }
              removePending={removeDomain.isPending && removeDomain.variables === domain.hostname}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CustomDomainRow({
  domain,
  cnameTarget,
  onRefresh,
  onRemove,
  refreshPending,
  removePending,
}: {
  domain: ProjectCustomDomain;
  cnameTarget: string;
  onRefresh: () => void;
  onRemove: () => void;
  refreshPending: boolean;
  removePending: boolean;
}) {
  const ownershipRecords = domain.ownershipVerification
    ? [{ ...domain.ownershipVerification, type: "TXT" }]
    : [];
  const trafficRecords = [
    { name: domain.hostname, type: "CNAME / ALIAS", value: cnameTarget },
    ...(domain.wildcard
      ? [{ name: `*.${domain.hostname}`, type: "CNAME", value: cnameTarget }]
      : []),
  ];
  const certificateRecords = domain.certificateDelegationCname
    ? [{ ...domain.certificateDelegationCname, type: "CNAME" }]
    : [];
  const certificateFallbackRecords =
    certificateRecords.length === 0
      ? domain.validationRecords.map((record) => ({ ...record, type: "TXT" }))
      : [];

  return (
    <div className="grid gap-3 p-3">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium">{domain.hostname}</p>
          <p className="text-xs text-muted-foreground">
            SSL {domain.sslStatus ?? "unknown"} / hostname {domain.hostnameStatus ?? "unknown"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <CustomDomainStatusBadge status={domain.status} />
          <Button
            aria-label={`Refresh ${domain.hostname}`}
            disabled={refreshPending || domain.status === "removing"}
            onClick={onRefresh}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <RefreshCwIcon aria-hidden="true" />
          </Button>
          <Button
            aria-label={`Remove ${domain.hostname}`}
            disabled={removePending || domain.status === "removing"}
            onClick={onRemove}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <Trash2Icon aria-hidden="true" />
          </Button>
        </div>
      </div>

      {domain.error ? <p className="text-xs text-destructive">{domain.error}</p> : null}

      <DomainSetupStep
        records={ownershipRecords}
        status={domain.hostnameStatus}
        title="Authorize domain"
      />
      <DomainSetupStep
        note={
          certificateRecords.length > 0
            ? "Remove any existing TXT records at this _acme-challenge name before adding the CNAME."
            : undefined
        }
        fallbackRecords={certificateFallbackRecords}
        records={certificateRecords}
        status={domain.sslStatus}
        title="Issue certificate"
      />
      <DomainSetupStep records={trafficRecords} title="Connect traffic" />
    </div>
  );
}

function DomainSetupStep({
  fallbackRecords = [],
  note,
  records,
  status,
  title,
}: {
  fallbackRecords?: DnsDisplayRecord[];
  note?: string;
  records: DnsDisplayRecord[];
  status?: string | null;
  title: string;
}) {
  if (records.length === 0 && fallbackRecords.length === 0) return null;
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium">{title}</p>
        {status !== undefined ? <DnsStatusBadge status={status} /> : null}
      </div>
      <div className="grid gap-1 text-xs">
        {records.map((record) => (
          <DnsLine key={`${record.type}:${record.name}:${record.value}`} record={record} />
        ))}
        {fallbackRecords.map((record) => (
          <DnsLine key={`${record.type}:${record.name}:${record.value}`} record={record} />
        ))}
      </div>
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}

type DnsDisplayRecord = { name: string; type: string; value: string };

function DnsLine({ record }: { record: DnsDisplayRecord }) {
  return (
    <div className="grid min-w-0 gap-1 sm:grid-cols-[6.25rem_minmax(0,1fr)_minmax(0,1.3fr)]">
      <code className="rounded bg-muted px-1.5 py-1 text-center">{record.type}</code>
      <DnsCopyCell
        copyLabel={`${record.type} name ${record.name}`}
        label="Name"
        value={record.name}
      />
      <DnsCopyCell
        copyLabel={`${record.type} value for ${record.name}`}
        label="Value"
        value={record.value}
      />
    </div>
  );
}

function DnsCopyCell({
  copyLabel,
  label,
  value,
}: {
  copyLabel: string;
  label: string;
  value: string;
}) {
  return (
    <div className="flex min-w-0 items-stretch gap-1">
      <code className="min-w-0 flex-1 rounded bg-muted px-1.5 py-1 break-all">
        <span className="mr-1 font-sans text-[0.65rem] font-medium text-muted-foreground uppercase">
          {label}
        </span>
        {value}
      </code>
      <Button
        aria-label={`Copy DNS ${copyLabel}`}
        className="h-auto min-h-7 w-7 shrink-0"
        onClick={() => copyToClipboard(value)}
        size="icon-xs"
        type="button"
        variant="outline"
      >
        <CopyIcon aria-hidden="true" />
      </Button>
    </div>
  );
}

function copyToClipboard(value: string) {
  if (!navigator.clipboard) {
    toast.error("Clipboard unavailable");
    return;
  }
  void navigator.clipboard.writeText(value).then(
    () => toast.success("Copied"),
    () => toast.error("Could not copy"),
  );
}

function primaryActiveCustomDomainHostname(
  domains?: readonly ProjectCustomDomain[] | null,
): string | null {
  const activeDomains = domains?.filter((domain) => domain.status === "active") ?? [];
  activeDomains.sort(comparePrimaryCustomDomain);
  return activeDomains.at(0)?.hostname ?? null;
}

function comparePrimaryCustomDomain(a: ProjectCustomDomain, b: ProjectCustomDomain) {
  return (
    hostnameLabelCount(a.hostname) - hostnameLabelCount(b.hostname) ||
    a.hostname.length - b.hostname.length ||
    a.hostname.localeCompare(b.hostname)
  );
}

function hostnameLabelCount(hostname: string) {
  return hostname.split(".").length;
}

function CustomDomainStatusBadge({ status }: { status: ProjectCustomDomain["status"] }) {
  const variant =
    status === "active" ? "default" : status === "failed" ? "destructive" : "secondary";
  return (
    <Badge className="capitalize" variant={variant}>
      {status.replaceAll("_", " ")}
    </Badge>
  );
}

function DnsStatusBadge({ status }: { status: string | null }) {
  const variant = status === "active" ? "default" : status === "failed" ? "destructive" : "outline";
  return (
    <Badge className="shrink-0 capitalize" variant={variant}>
      {status?.replaceAll("_", " ") ?? "pending"}
    </Badge>
  );
}

function SettingsField({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="grid gap-2 py-3 text-sm first:pt-0 last:pb-0">
      <p className="text-xs font-medium text-muted-foreground uppercase">{label}</p>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
