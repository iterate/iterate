// /projects/<slug>/hostnames — the project's own hostnames: `iterate.example.com` serves the project's
// site and `<app>.iterate.example.com` its apps. The `project` facet's LIVE STATE on `/` is the list
// (apps/os/src/project/contract.ts `hostnames`): what the processor still owes, Cloudflare's status
// and the CNAMEs the owner adds, and which live hostname is primary. Adding (`?add=1`, a sheet),
// checking again, removing and making primary each append ONE event to the root; the processor's
// answer lands in the live state.
import { useState, type FormEvent } from "react";
import { createFileRoute, getRouteApi, useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { z } from "zod";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import { Field, FieldLabel } from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@iterate-com/ui/components/sheet";
import { useContextStub, useFacetLiveState } from "iterate/react";

const shell = getRouteApi("/_auth");

/** The project facet's live state, the fields this page reads. */
const HostnamesLive = z.looseObject({
  primaryHostname: z.string().nullable().default(null),
  hostnames: z
    .record(
      z.string(),
      z.object({
        requested: z.object({ verb: z.enum(["add", "remove"]) }).nullable(),
        cloudflare: z
          .object({
            status: z.string(),
            sslStatus: z.string(),
            records: z.array(z.object({ name: z.string(), value: z.string() })),
          })
          .nullable(),
        error: z.string().nullable(),
      }),
    )
    .default({}),
});

export const Route = createFileRoute("/_auth/projects/$slug/hostnames")({
  validateSearch: z.object({ add: z.literal(1).optional().catch(undefined) }),
  staticData: { page: "Hostnames" },
  head: ({ params }) => ({ meta: [{ title: `Hostnames · ${params.slug} · Dash` }] }),
  component: ProjectHostnames,
});

function ProjectHostnames() {
  const { project } = Route.useRouteContext();
  const { api } = shell.useRouteContext();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const context = useContextStub(() => api.projects.get(project.id), [api, project.id]).stub;
  const live = useFacetLiveState(context, "project");
  const parsed = HostnamesLive.safeParse(live.value).data;
  const hostnames = Object.entries(parsed?.hostnames ?? {});
  const primaryHostname = parsed?.primaryHostname ?? null;
  const [error, setError] = useState<string | null>(null);
  const append = (event: { type: string; payload: { hostname: string | null } }) =>
    context!.append(event).then(
      () => setError(null),
      (caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)),
    );
  const request = (verb: "add" | "remove", hostname: string) =>
    append({
      type:
        verb === "add"
          ? "events.iterate.com/project/hostname-add-requested"
          : "events.iterate.com/project/hostname-remove-requested",
      payload: { hostname },
    });
  const configurePrimary = (hostname: string | null) =>
    append({
      type: "events.iterate.com/project/primary-hostname-configured",
      payload: { hostname },
    });
  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const hostname = String(new FormData(event.currentTarget).get("hostname"));
    await request("add", hostname.trim().toLowerCase().replace(/\.$/, ""));
    await navigate({ search: {}, replace: true });
  };
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 p-4 md:p-8">
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">Hostnames</h1>
          <Button disabled={!context} onClick={() => void navigate({ search: { add: 1 } })}>
            <Plus data-icon="inline-start" />
            Add hostname
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Serve this project on a domain of your own: <code>iterate.example.com</code> is its site,
          <code> &lt;app&gt;.iterate.example.com</code> its apps. Add the DNS records shown once; it
          goes live, with a certificate, when they are seen. A live hostname made primary is where
          the project&apos;s links point, and page visits to its default address are sent there.
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {hostnames.length === 0 ? (
        <p className="text-sm text-muted-foreground">No hostnames yet.</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border" data-testid="hostnames">
          {hostnames.map(([hostname, entry]) => {
            const live =
              entry.cloudflare?.status === "active" && entry.cloudflare.sslStatus === "active";
            const status = entry.requested
              ? entry.requested.verb === "remove"
                ? "Removing…"
                : "Checking…"
              : entry.error && !entry.cloudflare
                ? "Failed"
                : live
                  ? "Live"
                  : "Waiting for DNS";
            return (
              <li key={hostname} className="flex flex-col gap-3 p-4" data-hostname={hostname}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono">{hostname}</span>
                    <Badge variant={status === "Failed" ? "destructive" : "secondary"}>
                      {status}
                    </Badge>
                    {hostname === primaryHostname && <Badge>Primary</Badge>}
                  </div>
                  <div className="flex gap-2">
                    {hostname === primaryHostname ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void configurePrimary(null)}
                      >
                        Clear primary
                      </Button>
                    ) : live ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void configurePrimary(hostname)}
                      >
                        Make primary
                      </Button>
                    ) : null}
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={Boolean(entry.requested)}
                      onClick={() => void request("add", hostname)}
                    >
                      Check again
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={entry.requested?.verb === "remove"}
                      onClick={() => void request("remove", hostname)}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
                {entry.error && <p className="text-sm text-destructive">{entry.error}</p>}
                {entry.cloudflare && !live && (
                  <div className="flex flex-col gap-1 text-sm">
                    <p className="text-muted-foreground">
                      Add these CNAME records at your DNS provider (on Cloudflare, DNS only):
                    </p>
                    {entry.cloudflare.records.map((record) => (
                      <code key={record.name} className="break-all">
                        {record.name} CNAME {record.value}
                      </code>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <Sheet
        open={search.add === 1}
        onOpenChange={(open) => !open && void navigate({ search: {}, replace: true })}
      >
        <SheetContent
          side="right"
          className="data-[side=right]:w-full data-[side=right]:sm:max-w-md"
        >
          <form onSubmit={(event) => void add(event)} className="flex h-full flex-col">
            <SheetHeader>
              <SheetTitle>Add hostname</SheetTitle>
            </SheetHeader>
            <Field className="px-4">
              <FieldLabel htmlFor="hostname">Hostname</FieldLabel>
              <Input id="hostname" name="hostname" placeholder="iterate.example.com" required />
            </Field>
            <SheetFooter>
              <Button type="submit">Add hostname</Button>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>
    </div>
  );
}
