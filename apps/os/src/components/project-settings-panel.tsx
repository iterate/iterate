import type { FormEvent, ReactNode } from "react";
import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
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
import { normalizeProjectHostnameBase } from "~/lib/project-host-routing.ts";
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
  const defaultHostname = base ? `${project.slug}.${base}` : project.slug;
  const customDomains = projectState?.customDomains ?? [];

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
        <SettingsField label="Default hostname">
          <code className="text-xs">{defaultHostname}</code>
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

function CustomDomainsEditor({
  domains,
  projectHostnameBase,
  projectId,
}: {
  domains: ProjectCustomDomain[];
  projectHostnameBase: string;
  projectId: string;
}) {
  const [hostname, setHostname] = useState("");
  const existingHostnames = useMemo(
    () => new Set(domains.map((domain) => domain.hostname)),
    [domains],
  );
  const addDomain = useMutation({
    mutationFn: async () => {
      const result = await addProjectCustomDomainServerFn({
        data: { hostname, projectId },
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
    if (!trimmed || existingHostnames.has(trimmed)) return;
    addDomain.mutate();
  };

  return (
    <div className="grid gap-3">
      <form className="flex min-w-0 gap-2" onSubmit={onSubmit}>
        <Input
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          disabled={addDomain.isPending}
          onChange={(event) => setHostname(event.currentTarget.value)}
          placeholder="garple.com"
          spellCheck={false}
          value={hostname}
        />
        <Button
          aria-label="Add custom domain"
          disabled={addDomain.isPending || !hostname.trim()}
          size="icon"
          type="submit"
        >
          <PlusIcon aria-hidden="true" />
        </Button>
      </form>

      {domains.length === 0 ? (
        <p className="text-xs text-muted-foreground">No custom domains configured.</p>
      ) : (
        <div className="divide-y rounded-md border">
          {domains.map((domain) => (
            <CustomDomainRow
              domain={domain}
              key={domain.hostname}
              onRefresh={() => refreshDomain.mutate(domain.hostname)}
              onRemove={() => removeDomain.mutate(domain.hostname)}
              projectHostnameBase={projectHostnameBase}
              refreshPending={refreshDomain.isPending}
              removePending={removeDomain.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CustomDomainRow({
  domain,
  onRefresh,
  onRemove,
  projectHostnameBase,
  refreshPending,
  removePending,
}: {
  domain: ProjectCustomDomain;
  onRefresh: () => void;
  onRemove: () => void;
  projectHostnameBase: string;
  refreshPending: boolean;
  removePending: boolean;
}) {
  const cnameTarget = projectHostnameBase ? `cname.${projectHostnameBase}` : null;
  const validationRecords = [
    ...(domain.ownershipVerification ? [domain.ownershipVerification] : []),
    ...domain.validationRecords,
  ];

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

      {cnameTarget ? (
        <div className="grid gap-1 text-xs">
          <DnsLine label={domain.hostname} value={cnameTarget} />
          <DnsLine label={`*.${domain.hostname}`} value={cnameTarget} />
        </div>
      ) : null}

      {validationRecords.length > 0 ? (
        <div className="grid gap-1 text-xs">
          {validationRecords.map((record) => (
            <DnsLine
              key={`${record.name}:${record.value}`}
              label={record.name}
              value={record.value}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DnsLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid min-w-0 gap-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <code className="truncate rounded bg-muted px-1.5 py-1">{label}</code>
      <code className="truncate rounded bg-muted px-1.5 py-1">{value}</code>
    </div>
  );
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
