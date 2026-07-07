import type { FormEvent, ReactNode } from "react";
import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { CopyIcon, ExternalLinkIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import { Identifier } from "@iterate-com/ui/components/identifier";
import { Input } from "@iterate-com/ui/components/input";
import { toast } from "@iterate-com/ui/components/sonner";
import { StreamDebugLink } from "~/components/stream-debug-link.tsx";
import {
  addProjectCustomDomainServerFn,
  refreshProjectCustomDomainServerFn,
  removeProjectCustomDomainServerFn,
  type Project,
} from "~/lib/project-server-fns.ts";
import type { PublicRouteConfig } from "~/lib/public-route-config.ts";
import {
  buildProjectWorkerUrl,
  isValidCustomHostname,
  normalizeProjectHostnameBase,
} from "~/lib/project-host-routing.ts";
import type { ProjectCustomDomain, ProjectProcessorState } from "~/types.ts";

export function ProjectSettingsPanel({
  project,
  projectState,
  routeConfig,
}: {
  project: Project;
  projectState?: ProjectProcessorState;
  routeConfig: PublicRouteConfig;
}) {
  const base = normalizeProjectHostnameBase(routeConfig.projectHostnameBases[0] ?? "");
  const projectHostname = base ? `${project.slug}.${base}` : project.slug;
  const projectWorkerUrl = buildProjectWorkerUrl({
    appBaseUrl: routeConfig.baseUrl,
    projectHostnameBases: routeConfig.projectHostnameBases,
    projectSlug: project.slug,
  });
  const customDomains = projectState?.customDomains;

  return (
    <section className="flex flex-col gap-6" data-testid="project-settings-panel">
      <SettingsSection title="Project">
        <SettingsField label="Slug">
          <p className="font-medium">{project.slug}</p>
        </SettingsField>
        <SettingsField label="Project ID">
          <Identifier value={project.id} />
        </SettingsField>
        <SettingsField label="Streams">
          <StreamDebugLink label="Open project stream" projectSlug={project.slug} streamPath="/" />
        </SettingsField>
      </SettingsSection>

      <SettingsSection title="Hostname routing">
        <SettingsField label="Project slug hostname">
          <ProjectSlugHostname hostname={projectHostname} url={projectWorkerUrl} />
        </SettingsField>
        <SettingsField label="Custom domains">
          <CustomDomainsEditor
            domains={customDomains}
            projectId={project.id}
            projectHostnameBase={base}
          />
        </SettingsField>
      </SettingsSection>

      <SettingsSection title="Timestamps">
        <SettingsField label="Created">
          <p className="text-sm text-muted-foreground">{project.createdAt}</p>
        </SettingsField>
        <SettingsField label="Updated">
          <p className="text-sm text-muted-foreground">{project.updatedAt}</p>
        </SettingsField>
      </SettingsSection>
    </section>
  );
}

function ProjectSlugHostname({ hostname, url }: { hostname: string; url: string | null }) {
  const displayHost = hostFromUrl(url) ?? hostname;
  const appHostPattern = `<app>.${displayHost}`;

  return (
    <div className="grid gap-2 rounded-md border p-3">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium">{displayHost}</p>
          <p className="text-xs text-muted-foreground">Built-in project homepage</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            aria-label={`Copy project hostname ${displayHost}`}
            onClick={() => copyToClipboard(displayHost)}
            size="icon-xs"
            type="button"
            variant="outline"
          >
            <CopyIcon aria-hidden="true" />
          </Button>
          {url ? (
            <Button
              aria-label={`Open project homepage ${displayHost}`}
              render={
                <a href={url} target="_blank" rel="noreferrer">
                  <span className="sr-only">Open project homepage</span>
                </a>
              }
              size="icon-xs"
              type="button"
              variant="outline"
            >
              <ExternalLinkIcon aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </div>
      <div className="grid gap-1 text-xs">
        <p className="text-muted-foreground">Apps route from subdomains on the same host.</p>
        <code className="min-w-0 rounded bg-muted px-1.5 py-1 break-all">{appHostPattern}</code>
      </div>
    </div>
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
    onSuccess: (addedHostname) => {
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
    onSuccess: (refreshedHostname) => toast.success(`Refresh queued: ${refreshedHostname}`),
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });
  const removeDomain = useMutation({
    mutationFn: async (domainHostname: string) => {
      const result = await removeProjectCustomDomainServerFn({
        data: { hostname: domainHostname, projectId },
      });
      return result.hostname;
    },
    onSuccess: (removedHostname) => toast.success(`Removal queued: ${removedHostname}`),
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

function hostFromUrl(url: string | null) {
  if (!url || !URL.canParse(url)) return null;
  return new URL(url).host;
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

function SettingsSection({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xs font-medium text-muted-foreground uppercase">{title}</h2>
      <div className="flex flex-col divide-y">{children}</div>
    </section>
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
