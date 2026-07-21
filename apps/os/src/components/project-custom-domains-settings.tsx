import type { FormEvent } from "react";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { Input } from "@iterate-com/ui/components/input";
import { toast } from "@iterate-com/ui/components/sonner";
import { connectItx } from "iterate/sdk/itx/react";
import { ProjectProcessorContract } from "~/domains/projects/project-processor-contract.ts";
import {
  isReservedProjectHostname,
  isValidCustomHostname,
  normalizeCustomHostname,
  normalizeProjectHostnameBase,
} from "~/lib/project-host-routing.ts";
import type { PublicRouteConfig } from "~/lib/public-route-config.ts";
import type {
  ProjectCustomDomain,
  ProjectProcessorState,
} from "~/domains/projects/project-processor-contract.ts";

export function ProjectCustomDomainsSettings({
  projectId,
  projectState,
  routeConfig,
}: {
  projectId: string;
  projectState?: ProjectProcessorState;
  routeConfig: PublicRouteConfig;
}) {
  const base = normalizeProjectHostnameBase(routeConfig.projectHostnameBases[0] ?? "");
  const customDomains = projectState?.customDomains;

  return (
    <section className="flex flex-col gap-3" data-testid="project-custom-domains-settings">
      <h2 className="text-xs font-medium text-muted-foreground uppercase">Custom domains</h2>
      <div className="grid gap-2 py-3 text-sm">
        <p className="text-xs font-medium text-muted-foreground uppercase">DNS setup</p>
        <CustomDomainsEditor
          domains={customDomains}
          projectId={projectId}
          projectHostnameBase={base}
          projectHostnameBases={routeConfig.projectHostnameBases}
        />
      </div>
    </section>
  );
}

function CustomDomainsEditor({
  domains,
  projectHostnameBase,
  projectHostnameBases,
  projectId,
}: {
  domains?: ProjectCustomDomain[];
  projectHostnameBase: string;
  projectHostnameBases: readonly string[];
  projectId: string;
}) {
  const [hostname, setHostname] = useState("");
  const cnameTarget = isValidCustomHostname(projectHostnameBase)
    ? `cname.${projectHostnameBase}`
    : null;
  const mutation = useMutation({
    mutationFn: async (input: { action: "add" | "refresh" | "remove"; hostname: string }) => {
      const normalizedHostname = normalizeProjectCustomDomainInput({
        hostname: input.hostname,
        projectHostnameBases,
      });
      const itx = await connectItx(projectId);
      await itx.streams.get("/").append(
        ProjectProcessorContract.buildEvent({
          type: customDomainEventType(input.action),
          payload: { hostname: normalizedHostname },
        }),
      );
      return { action: input.action, hostname: normalizedHostname };
    },
    onSuccess: async ({ action, hostname: mutatedHostname }) => {
      if (action === "add") setHostname("");
      toast.success(
        action === "add"
          ? `Custom domain queued: ${mutatedHostname}`
          : action === "refresh"
            ? `Refresh queued: ${mutatedHostname}`
            : `Removal queued: ${mutatedHostname}`,
      );
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = hostname.trim().toLowerCase();
    if (!trimmed || !cnameTarget || domains?.some((domain) => domain.hostname === trimmed)) return;
    mutation.mutate({ action: "add", hostname: trimmed });
  };

  return (
    <div className="grid gap-3">
      <form className="flex min-w-0 gap-2" onSubmit={onSubmit}>
        <Input
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          disabled={mutation.isPending || !cnameTarget}
          onChange={(event) => setHostname(event.currentTarget.value)}
          placeholder="garple.com"
          value={hostname}
        />
        <Button
          aria-label="Add custom domain"
          disabled={mutation.isPending || !hostname.trim() || !cnameTarget}
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
              onRefresh={() => mutation.mutate({ action: "refresh", hostname: domain.hostname })}
              onRemove={() => mutation.mutate({ action: "remove", hostname: domain.hostname })}
              cnameTarget={cnameTarget}
              mutationPending={mutation.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function customDomainEventType(action: "add" | "refresh" | "remove") {
  switch (action) {
    case "add":
      return "events.iterate.com/project/custom-domain-add-requested";
    case "refresh":
      return "events.iterate.com/project/custom-domain-refresh-requested";
    case "remove":
      return "events.iterate.com/project/custom-domain-remove-requested";
  }
}

function normalizeProjectCustomDomainInput(input: {
  hostname: string;
  projectHostnameBases: readonly string[];
}) {
  const hostname = normalizeCustomHostname(input.hostname);
  if (!hostname || !isValidCustomHostname(hostname)) {
    throw new Error("Enter a valid DNS hostname, such as garple.com.");
  }
  if (isReservedProjectHostname(hostname, input.projectHostnameBases)) {
    throw new Error(`"${hostname}" is reserved for iterate project hostnames.`);
  }
  return hostname;
}

function CustomDomainRow({
  domain,
  cnameTarget,
  onRefresh,
  onRemove,
  mutationPending,
}: {
  domain: ProjectCustomDomain;
  cnameTarget: string;
  onRefresh: () => void;
  onRemove: () => void;
  mutationPending: boolean;
}) {
  // Direct registrations (platform-owned apexes routed by worker routes + the
  // hostname directory) have no Cloudflare provisioning lifecycle: no DNS
  // setup steps apply, and refresh/remove must never run — the provisioning
  // path would tear down the live routing registration.
  const direct = domain.kind === "direct";
  const ownershipRecords = domain.ownershipVerification
    ? [{ ...domain.ownershipVerification, type: "TXT" }]
    : [];
  const trafficRecords = [
    { name: domain.hostname, type: "CNAME / ALIAS", value: cnameTarget },
    ...(domain.wildcard
      ? [{ name: `*.${domain.hostname}`, type: "CNAME", value: cnameTarget }]
      : []),
  ];
  const certificateRecords = domain.validationRecords.map((record) => ({
    ...record,
    type: "TXT",
  }));

  return (
    <div className="grid gap-3 p-3">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium">{domain.hostname}</p>
          <p className="text-xs text-muted-foreground">
            {direct
              ? "Served directly by iterate — no DNS setup required"
              : `SSL ${domain.sslStatus ?? "unknown"} / hostname ${domain.hostnameStatus ?? "unknown"}`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {direct ? (
            <span className="rounded border px-1.5 py-0.5 text-xs capitalize">Direct</span>
          ) : null}
          <span className="rounded border px-1.5 py-0.5 text-xs capitalize">
            {domain.status.replaceAll("_", " ")}
          </span>
          {direct ? null : (
            <>
              <Button
                aria-label={`Refresh ${domain.hostname}`}
                disabled={mutationPending || domain.status === "removing"}
                onClick={onRefresh}
                size="icon-xs"
                type="button"
                variant="ghost"
              >
                <RefreshCwIcon aria-hidden="true" />
              </Button>
              <Button
                aria-label={`Remove ${domain.hostname}`}
                disabled={mutationPending || domain.status === "removing"}
                onClick={onRemove}
                size="icon-xs"
                type="button"
                variant="ghost"
              >
                <Trash2Icon aria-hidden="true" />
              </Button>
            </>
          )}
        </div>
      </div>

      {domain.error ? <p className="text-xs text-destructive">{domain.error}</p> : null}

      {direct ? null : (
        <>
          <DomainSetupStep records={ownershipRecords} title="Authorize domain" />
          <DomainSetupStep records={certificateRecords} title="Issue certificate" />
          <DomainSetupStep records={trafficRecords} title="Connect traffic" />
        </>
      )}
    </div>
  );
}

function DomainSetupStep({ records, title }: { records: DnsDisplayRecord[]; title: string }) {
  if (records.length === 0) return null;
  return (
    <div className="grid gap-1.5">
      <p className="text-xs font-medium">{title}</p>
      <div className="grid gap-1 text-xs">
        {records.map((record) => (
          <DnsLine key={`${record.type}:${record.name}:${record.value}`} record={record} />
        ))}
      </div>
    </div>
  );
}

type DnsDisplayRecord = { name: string; type: string; value: string };

function DnsLine({ record }: { record: DnsDisplayRecord }) {
  return (
    <div className="grid min-w-0 gap-1 sm:grid-cols-[6.25rem_minmax(0,1fr)_minmax(0,1.3fr)]">
      <code className="rounded bg-muted px-1.5 py-1 text-center">{record.type}</code>
      <DnsCell label="Name" value={record.name} />
      <DnsCell label="Value" value={record.value} />
    </div>
  );
}

function DnsCell({ label, value }: { label: string; value: string }) {
  return (
    <code className="min-w-0 rounded bg-muted px-1.5 py-1 break-all">
      <span className="mr-1 font-sans text-[0.65rem] font-medium text-muted-foreground uppercase">
        {label}
      </span>
      {value}
    </code>
  );
}
