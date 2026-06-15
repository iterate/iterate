import { useCallback, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Button } from "@iterate-com/ui/components/button";
import { Identifier } from "@iterate-com/ui/components/identifier";
import { Input } from "@iterate-com/ui/components/input";
import { toast } from "@iterate-com/ui/components/sonner";
import { StreamDebugLink } from "~/components/stream-debug-link.tsx";
import { normalizeProjectHostnameBase } from "~/lib/project-host-routing.ts";
import type { Project } from "~/lib/project-server-fns.ts";
import type { PublicRouteConfig } from "~/lib/public-route-config.ts";
import { useItx } from "~/itx/itx-react.tsx";
import type { ItxProjects } from "~/itx/handle.ts";

type CustomHostnameStatus = Awaited<ReturnType<ItxProjects["customHostnameStatus"]>>;

export function ProjectSettingsPanel({
  project,
  routeConfig,
}: {
  project: Project;
  routeConfig: PublicRouteConfig;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const itx = useItx();
  const [customHostname, setCustomHostname] = useState(project.customHostname ?? "");
  const [hostnameToActivate, setHostnameToActivate] = useState("");
  const dnsInstructions = customHostnameDnsInstructions({
    customHostname,
    project,
    projectHostnameBases: routeConfig.projectHostnameBases,
  });
  const statusKey = ["itx", "customHostnameStatus", project.slug];
  const customHostnameStatusQuery = useQuery({
    queryKey: statusKey,
    queryFn: () => itx.projects.customHostnameStatus({ id: project.id }),
    enabled: Boolean(project.customHostname),
    refetchInterval: (query) =>
      query.state.data?.hostnames.some((hostname) => hostname.sslStatus !== "active")
        ? 10_000
        : false,
  });
  const updateConfig = useMutation({
    mutationFn: (input: { id: string; customHostname: string | null }) =>
      itx.projects.updateConfig(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: statusKey });
      // The project itself comes from the route loader — re-run it to pick up
      // the saved config (the itx surface has no separate find/list cache).
      void router.invalidate();
      toast.success("Project config saved.");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });
  const ensureCustomHostname = useMutation({
    mutationFn: (input: { id: string; hostname: string }) =>
      itx.projects.ensureCustomHostname(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: statusKey });
      toast.success("Custom hostname activated.");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const handleUpdateConfig = useCallback(() => {
    updateConfig.mutate({
      id: project.id,
      customHostname: customHostname.trim() === "" ? null : customHostname,
    });
  }, [customHostname, project.id, updateConfig]);
  const handleActivateHostname = useCallback(() => {
    ensureCustomHostname.mutate({
      id: project.id,
      hostname: hostnameToActivate,
    });
  }, [ensureCustomHostname, hostnameToActivate, project.id]);

  return (
    <section className="flex flex-col gap-6">
      <SettingsSection title="Project">
        <SettingsField label="Slug">
          <p className="font-medium">{project.slug}</p>
        </SettingsField>
        <SettingsField label="Project ID">
          <Identifier value={project.id} />
        </SettingsField>
        <SettingsField label="Stream namespace">
          <StreamDebugLink label="Open project stream" projectSlug={project.slug} streamPath="/" />
        </SettingsField>
      </SettingsSection>

      <SettingsSection title="Hostname routing">
        <SettingsField label="Custom hostname">
          <div className="flex flex-col gap-2">
            <Input
              placeholder="app.example.com"
              value={customHostname}
              onChange={(event) => setCustomHostname(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && handleUpdateConfig()}
            />
            <CustomHostnameDnsInstructions instructions={dnsInstructions} />
            <div>
              <Button size="sm" onClick={handleUpdateConfig} disabled={updateConfig.isPending}>
                {updateConfig.isPending ? "Saving..." : "Save"}
              </Button>
            </div>
          </div>
        </SettingsField>

        {project.customHostname ? (
          <SettingsField label="Activate hostname">
            <div className="flex flex-col gap-2">
              <CustomHostnameCloudflareStatus
                status={customHostnameStatusQuery.data}
                isPending={customHostnameStatusQuery.isPending}
              />
              <div className="flex gap-2">
                <Input
                  placeholder={`app1.${project.customHostname}`}
                  value={hostnameToActivate}
                  onChange={(event) => setHostnameToActivate(event.target.value)}
                  onKeyDown={(event) => event.key === "Enter" && handleActivateHostname()}
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleActivateHostname}
                  disabled={ensureCustomHostname.isPending || hostnameToActivate.trim() === ""}
                >
                  {ensureCustomHostname.isPending ? "Activating..." : "Activate"}
                </Button>
              </div>
            </div>
          </SettingsField>
        ) : null}
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

function CustomHostnameDnsInstructions({
  instructions,
}: {
  instructions: CustomHostnameDnsInstructionsData;
}) {
  if (instructions.kind === "empty") {
    return (
      <p className="text-xs text-muted-foreground">
        Optional. Use a custom hostname instead of{" "}
        <code className="text-xs">{instructions.defaultHostname}</code>.
      </p>
    );
  }

  if (instructions.kind === "missing-base") {
    return (
      <p className="text-xs text-muted-foreground">
        This deployment does not have a project hostname base configured, so DNS instructions cannot
        be generated here.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2 text-xs text-muted-foreground">
      <p>
        Point these DNS-only CNAME records to <code className="text-xs">{instructions.target}</code>
        :
      </p>
      <div className="flex flex-col gap-1 font-mono text-xs text-foreground">
        <div>
          <span className="text-muted-foreground">CNAME</span> <code>{instructions.hostname}</code>
        </div>
        <div>
          <span className="text-muted-foreground">CNAME</span>{" "}
          <code>{instructions.wildcardHostname}</code>
        </div>
      </div>
      <p>
        If <code className="text-xs">{instructions.hostname}</code> is an apex/root domain, use your
        DNS provider's ALIAS, ANAME, or CNAME flattening feature for that record. Keep the wildcard
        as a normal CNAME. In Cloudflare-managed customer zones, leave both records DNS-only.
      </p>
      <p>
        Cloudflare still needs each app hostname activated below before it can serve requests for
        that hostname. Wildcard custom hostnames require a Cloudflare Enterprise entitlement on the
        provider zone.
      </p>
    </div>
  );
}

function CustomHostnameCloudflareStatus({
  isPending,
  status,
}: {
  isPending: boolean;
  status: CustomHostnameStatus | undefined;
}) {
  if (isPending) {
    return <p className="text-xs text-muted-foreground">Checking Cloudflare hostname status...</p>;
  }

  if (!status) return null;

  if (!status.cloudflareConfigured) {
    return status.message ? (
      <p className="text-xs text-muted-foreground">{status.message}</p>
    ) : null;
  }

  return (
    <div className="flex flex-col gap-2 text-xs text-muted-foreground">
      <p>Cloudflare custom hostname certificates:</p>
      <div className="flex flex-col gap-2">
        {status.hostnames.map((hostname) => (
          <div key={hostname.id} className="flex flex-col gap-1">
            <div className="flex flex-wrap gap-x-2 gap-y-1">
              <code className="text-xs text-foreground">{hostname.hostname}</code>
              <span>{hostname.wildcard ? "wildcard enabled" : "wildcard disabled"}</span>
              <span>hostname: {hostname.hostnameStatus ?? "unknown"}</span>
              <span>ssl: {hostname.sslStatus ?? "unknown"}</span>
            </div>
            {hostname.ownershipVerificationName && hostname.ownershipVerificationValue ? (
              <DnsTextRecord
                label="Ownership TXT"
                name={hostname.ownershipVerificationName}
                value={hostname.ownershipVerificationValue}
              />
            ) : null}
            {hostname.validationRecords.map((record) => (
              <DnsTextRecord
                key={`${hostname.id}:${record.txtName}:${record.txtValue}`}
                label={record.status ? `Certificate TXT (${record.status})` : "Certificate TXT"}
                name={record.txtName}
                value={record.txtValue}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function DnsTextRecord({ label, name, value }: { label: string; name: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <p>{label}</p>
      <div className="font-mono text-xs text-foreground">
        <span className="text-muted-foreground">TXT</span> <code>{name}</code> <code>{value}</code>
      </div>
    </div>
  );
}

type CustomHostnameDnsInstructionsData =
  | { defaultHostname: string; kind: "empty" }
  | { kind: "missing-base" }
  | {
      hostname: string;
      kind: "ready";
      target: string;
      wildcardHostname: string;
    };

function customHostnameDnsInstructions(input: {
  customHostname: string;
  project: Project;
  projectHostnameBases: readonly string[];
}): CustomHostnameDnsInstructionsData {
  const base = normalizeProjectHostnameBase(input.projectHostnameBases[0] ?? "");
  const defaultHostname = base ? `${input.project.slug}.${base}` : input.project.slug;
  const hostname = input.customHostname.trim().toLowerCase();

  if (!hostname) {
    return { defaultHostname, kind: "empty" };
  }

  if (!base) {
    return { kind: "missing-base" };
  }

  return {
    hostname,
    kind: "ready",
    target: `cname.${base}`,
    wildcardHostname: `*.${hostname}`,
  };
}
