import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Badge } from "@iterate-com/ui/components/badge";
import { ScrollArea } from "@iterate-com/ui/components/scroll-area";
import { orpc } from "@/lib/orpc.ts";

export const Route = createFileRoute("/_app/deployments/$slug/services")({
  component: DeploymentServicesPage,
});

function DeploymentServicesPage() {
  const { slug } = Route.useParams();
  const { data: registrations } = useSuspenseQuery({
    ...orpc.deployments.services.list.queryOptions({ input: { slug } }),
    refetchInterval: 2_000,
  });

  const [selectedHost, setSelectedHost] = useState<string | null>(null);

  const selectedRegistration = useMemo(() => {
    if (registrations.length === 0) return null;
    return registrations.find((route) => route.host === selectedHost) ?? registrations[0] ?? null;
  }, [registrations, selectedHost]);

  return (
    <div className="h-full overflow-hidden p-4">
      <div className="grid h-full gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <section className="min-h-0 overflow-hidden rounded-xl border bg-card">
          <div className="border-b px-4 py-3">
            <h2 className="text-sm font-medium">Services</h2>
            <p className="text-xs text-muted-foreground">
              {registrations.length} registry registrations
            </p>
          </div>

          {registrations.length === 0 ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">
              No registry service registrations found.
            </div>
          ) : (
            <ScrollArea className="h-[calc(100%-73px)]">
              <div className="space-y-3 p-3">
                {registrations.map((registration) => {
                  const isSelected = registration.host === selectedRegistration?.host;

                  return (
                    <button
                      key={registration.host}
                      type="button"
                      onClick={() => setSelectedHost(registration.host)}
                      className={`w-full rounded-lg border p-3 text-left transition-colors ${
                        isSelected
                          ? "border-primary bg-accent/40"
                          : "bg-background hover:bg-accent/20"
                      }`}
                    >
                      <div className="truncate font-medium">
                        {serviceNameFromHost(registration.host)}
                      </div>
                      <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
                        {registration.host}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span>{registration.targetHost}</span>
                        <span>port {registration.targetPort ?? "?"}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </ScrollArea>
          )}
        </section>

        <section className="min-h-0 overflow-hidden rounded-xl border bg-card">
          <div className="border-b px-4 py-3">
            {selectedRegistration ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {serviceNameFromHost(selectedRegistration.host)}
                  </div>
                  <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
                    {selectedRegistration.host}
                  </div>
                </div>
                <Badge variant="outline">port {selectedRegistration.targetPort ?? "?"}</Badge>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">
                Select a service registration to inspect it.
              </div>
            )}
          </div>

          {selectedRegistration ? (
            <ScrollArea className="h-[calc(100%-73px)]">
              <div className="space-y-6 p-4">
                <DetailRow label="Registration Host" value={selectedRegistration.host} mono />
                <DetailRow label="Target" value={selectedRegistration.target} mono />
                <DetailRow label="Target Host" value={selectedRegistration.targetHost} mono />
                <DetailRow
                  label="Target Port"
                  value={
                    selectedRegistration.targetPort === null
                      ? "Unknown"
                      : String(selectedRegistration.targetPort)
                  }
                  mono
                />
                <DetailRow label="Updated" value={selectedRegistration.updatedAt} mono />

                <div className="space-y-2">
                  <div className="text-sm font-medium text-muted-foreground">Tags</div>
                  {selectedRegistration.tags.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {selectedRegistration.tags.map((tag) => (
                        <Badge key={tag} variant="outline">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No tags.</p>
                  )}
                </div>

                <div className="space-y-2">
                  <div className="text-sm font-medium text-muted-foreground">Metadata</div>
                  {Object.keys(selectedRegistration.metadata).length > 0 ? (
                    <pre className="overflow-auto rounded-lg border bg-background p-3 text-xs font-mono">
                      {JSON.stringify(selectedRegistration.metadata, null, 2)}
                    </pre>
                  ) : (
                    <p className="text-sm text-muted-foreground">No metadata.</p>
                  )}
                </div>
              </div>
            </ScrollArea>
          ) : (
            <div className="px-4 py-6 text-sm text-muted-foreground">No service selected.</div>
          )}
        </section>
      </div>
    </div>
  );
}

function DetailRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="space-y-1">
      <div className="text-sm font-medium text-muted-foreground">{label}</div>
      <div className={mono ? "font-mono text-sm" : "text-sm"}>{value}</div>
    </div>
  );
}

function serviceNameFromHost(host: string) {
  return host.replace(/\.iterate\.localhost$/, "");
}
