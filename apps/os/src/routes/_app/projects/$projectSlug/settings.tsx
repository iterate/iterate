import { Suspense, useEffect, useState } from "react";
import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import type { Project } from "@iterate-com/os-contract";
import { Button } from "@iterate-com/ui/components/button";
import { Identifier } from "@iterate-com/ui/components/identifier";
import { Input } from "@iterate-com/ui/components/input";
import { toast } from "@iterate-com/ui/components/sonner";
import { StreamDebugLink } from "~/components/stream-debug-link.tsx";
import type { ProjectCustomHostnameStatus } from "~/domains/projects/cloudflare-custom-hostnames.ts";
import { useItx } from "~/itx/use-itx.ts";
import { normalizeProjectHostnameBase } from "~/lib/project-host-routing.ts";
import { getPublicRouteConfig } from "~/lib/public-route-config.ts";

export const Route = createFileRoute("/_app/projects/$projectSlug/settings")({
  ssr: false,
  loader: async ({ context }) => ({
    breadcrumb: "Settings",
    project: context.project,
    routeConfig: await getPublicRouteConfig(),
  }),
  component: ProjectDetailPage,
});

function ProjectDetailPage() {
  return (
    <Suspense
      fallback={<div className="p-4 text-sm text-muted-foreground">Connecting to itx...</div>}
    >
      <ProjectDetailContent />
    </Suspense>
  );
}

function ProjectDetailContent() {
  const { project, routeConfig } = Route.useLoaderData();
  const router = useRouter();
  const itx = useItx(project.id);
  const [customHostname, setCustomHostname] = useState(project.customHostname ?? "");
  const [hostnameToActivate, setHostnameToActivate] = useState("");
  const [hostnameStatus, setHostnameStatus] = useState<ProjectCustomHostnameStatus>();
  const [isSaving, setIsSaving] = useState(false);
  const [isActivating, setIsActivating] = useState(false);
  const dnsInstructions = customHostnameDnsInstructions({
    customHostname,
    project,
    projectHostnameBases: routeConfig.projectHostnameBases,
  });

  // Cloudflare hostname status: one fetch on mount, then a 10s re-poll while
  // any certificate is still pending (the old refetchInterval behavior).
  useEffect(() => {
    if (!project.customHostname) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const status = await itx.project.customHostnameStatus();
        if (cancelled) return;
        setHostnameStatus(status);
        if (status.hostnames.some((hostname) => hostname.sslStatus !== "active")) {
          timer = setTimeout(() => void load(), 10_000);
        }
      } catch (error) {
        if (!cancelled) {
          toast.error(error instanceof Error ? error.message : String(error));
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [itx, project.customHostname]);

  async function handleUpdateConfig() {
    setIsSaving(true);
    try {
      await itx.project.updateConfig({
        customHostname: customHostname.trim() === "" ? null : customHostname,
      });
      // Re-runs the route loaders so context.project picks up the new config.
      void router.invalidate();
      toast.success("Project config saved.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  }

  async function handleActivateHostname() {
    setIsActivating(true);
    try {
      await itx.project.ensureCustomHostname({ hostname: hostnameToActivate });
      setHostnameStatus(await itx.project.customHostnameStatus());
      toast.success("Custom hostname activated.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setIsActivating(false);
    }
  }

  return (
    <section className="space-y-4 p-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">{project.slug}</h2>
        <p className="text-sm text-muted-foreground">
          Update hostname routing and inspect the stored project fields.
        </p>
      </div>

      <div className="space-y-3 rounded-lg border bg-card p-4">
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Slug</p>
          <p className="font-medium">{project.slug}</p>
        </div>

        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Project ID</p>
          <Identifier value={project.id} />
        </div>

        <div className="space-y-2">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Stream namespace</p>
          <StreamDebugLink label="Open project stream" projectSlug={project.slug} streamPath="/" />
        </div>

        <div className="space-y-2">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Custom hostname</p>
          <div className="flex gap-2">
            <Input
              placeholder="app.example.com"
              value={customHostname}
              onChange={(event) => setCustomHostname(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && void handleUpdateConfig()}
            />
          </div>
          <CustomHostnameDnsInstructions instructions={dnsInstructions} />
          {project.customHostname ? (
            <div className="space-y-2">
              <CustomHostnameCloudflareStatus
                status={hostnameStatus}
                isPending={hostnameStatus === undefined}
              />
              <div className="flex gap-2">
                <Input
                  placeholder={`app1.${project.customHostname}`}
                  value={hostnameToActivate}
                  onChange={(event) => setHostnameToActivate(event.target.value)}
                  onKeyDown={(event) => event.key === "Enter" && void handleActivateHostname()}
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void handleActivateHostname()}
                  disabled={isActivating || hostnameToActivate.trim() === ""}
                >
                  {isActivating ? "Activating..." : "Activate"}
                </Button>
              </div>
            </div>
          ) : null}
        </div>

        <Button size="sm" onClick={() => void handleUpdateConfig()} disabled={isSaving}>
          {isSaving ? "Saving..." : "Save"}
        </Button>

        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Created</p>
          <p className="text-sm text-muted-foreground">{project.createdAt}</p>
        </div>

        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Updated</p>
          <p className="text-sm text-muted-foreground">{project.updatedAt}</p>
        </div>
      </div>

      <Button size="sm" variant="outline" nativeButton={false} render={<Link to="/projects" />}>
        Back to projects
      </Button>
    </section>
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
    <div className="space-y-2 text-xs text-muted-foreground">
      <p>
        Point these DNS-only CNAME records to <code className="text-xs">{instructions.target}</code>
        :
      </p>
      <div className="space-y-1 font-mono text-xs text-foreground">
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
  status: ProjectCustomHostnameStatus | undefined;
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
    <div className="space-y-2 text-xs text-muted-foreground">
      <p>Cloudflare custom hostname certificates:</p>
      <div className="space-y-2">
        {status.hostnames.map((hostname) => (
          <div key={hostname.id} className="space-y-1">
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
    <div className="space-y-0.5">
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
