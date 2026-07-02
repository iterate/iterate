import type { ReactNode } from "react";
import { Identifier } from "@iterate-com/ui/components/identifier";
import { StreamDebugLink } from "~/components/stream-debug-link.tsx";
import type { Project } from "~/lib/project-server-fns.ts";
import type { PublicRouteConfig } from "~/lib/public-route-config.ts";
import { normalizeProjectHostnameBase } from "~/lib/project-host-routing.ts";

export function ProjectSettingsPanel({
  project,
  routeConfig,
}: {
  project: Project;
  routeConfig: PublicRouteConfig;
}) {
  const base = normalizeProjectHostnameBase(routeConfig.projectHostnameBases[0] ?? "");
  const defaultHostname = base ? `${project.slug}.${base}` : project.slug;

  return (
    <section className="flex flex-col gap-6">
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
        {/* TODO(task #13): custom hostnames (updateConfig/ensureCustomHostname)
            have no itx surface yet — restore this section when they do. */}
        <SettingsField label="Custom hostname">
          <p className="text-xs text-muted-foreground">
            Custom hostnames return soon (TODO task #13). This project is served at{" "}
            <code className="text-xs">{defaultHostname}</code>.
          </p>
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
