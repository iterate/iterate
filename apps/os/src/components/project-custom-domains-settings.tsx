import type { FormEvent } from "react";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { Input } from "@iterate-com/ui/components/input";
import { toast } from "@iterate-com/ui/components/sonner";
import { connectItx } from "iterate/sdk/itx/react";
import {
  ProjectProcessorContract,
  type ProjectCustomDomain,
  type ProjectProcessorState,
} from "~/domains/projects/project-processor-contract.ts";
import {
  isReservedProjectHostname,
  isValidCustomHostname,
  normalizeCustomHostname,
  normalizeProjectHostnameBase,
} from "~/lib/project-host-routing.ts";
import type { PublicRouteConfig } from "~/lib/public-route-config.ts";

export function ProjectCustomDomainsSettings({
  projectId,
  projectState,
  routeConfig,
}: {
  projectId: string;
  projectState?: ProjectProcessorState;
  routeConfig: PublicRouteConfig;
}) {
  return (
    <section className="flex flex-col gap-3" data-testid="project-custom-domains-settings">
      <h2 className="text-xs font-medium text-muted-foreground uppercase">Custom domains</h2>
      <CustomDomainsEditor
        domains={projectState?.customDomains}
        projectId={projectId}
        projectHostnameBase={normalizeProjectHostnameBase(
          routeConfig.projectHostnameBases[0] ?? "",
        )}
        projectHostnameBases={routeConfig.projectHostnameBases}
      />
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
    mutationFn: async (input: { action: "add" | "remove"; hostname: string }) => {
      const normalizedHostname = normalizeProjectCustomDomainInput({
        hostname: input.hostname,
        projectHostnameBases,
      });
      const itx = await connectItx(projectId);
      await itx.streams.get("/").append(
        ProjectProcessorContract.buildEvent({
          type:
            input.action === "add"
              ? "events.iterate.com/project/custom-domain-add-requested"
              : "events.iterate.com/project/custom-domain-remove-requested",
          payload: { hostname: normalizedHostname },
        }),
      );
      return { action: input.action, hostname: normalizedHostname };
    },
    onSuccess: ({ action, hostname: mutatedHostname }) => {
      if (action === "add") setHostname("");
      toast.success(
        action === "add"
          ? `Custom domain queued: ${mutatedHostname}`
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
    <div className="grid gap-3 py-3 text-sm">
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

      {cnameTarget ? (
        domains ? (
          domains.length === 0 ? (
            <p className="text-xs text-muted-foreground">No custom domains configured.</p>
          ) : (
            <div className="divide-y rounded-md border">
              {domains.map((domain) => (
                <CustomDomainRow
                  cnameTarget={cnameTarget}
                  domain={domain}
                  key={domain.hostname}
                  mutationPending={mutation.isPending}
                  onRemove={() => mutation.mutate({ action: "remove", hostname: domain.hostname })}
                />
              ))}
            </div>
          )
        ) : (
          <p className="text-xs text-muted-foreground">Loading custom domains...</p>
        )
      ) : (
        <p className="text-xs text-muted-foreground">
          Custom domains require a deployed DNS project hostname base.
        </p>
      )}
    </div>
  );
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
  onRemove,
  mutationPending,
}: {
  domain: ProjectCustomDomain;
  cnameTarget: string;
  onRemove: () => void;
  mutationPending: boolean;
}) {
  const direct = domain.kind === "direct";
  return (
    <div className="grid gap-2 p-3">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium">{domain.hostname}</p>
          <p className="text-xs text-muted-foreground">
            {direct ? "Served directly by iterate" : `CNAME / ALIAS → ${cnameTarget}`}
          </p>
          {direct ? null : (
            <p className="text-xs text-muted-foreground">
              *.{domain.hostname} → {cnameTarget}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <span className="rounded border px-1.5 py-0.5 text-xs capitalize">{domain.kind}</span>
          {direct ? null : (
            <Button
              aria-label={`Remove ${domain.hostname}`}
              disabled={mutationPending}
              onClick={onRemove}
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              <Trash2Icon aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
