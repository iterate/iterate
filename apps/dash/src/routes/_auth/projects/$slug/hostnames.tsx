// /projects/<slug>/hostnames — the project's own hostnames: `www.example.com` serving the project's
// site as `<project>.<hostname>` does. The `project` facet's LIVE STATE on `/` is the list
// (apps/os/src/project/contract.ts `hostnames`): each hostname, what the processor still owes, and
// Cloudflare's last word — its status and the CNAME record its owner adds. Adding one
// is a SHEET (`?add=1`); adding, re-checking and removing are each ONE event appended to the root
// (`project/hostname-add-requested`, again for a re-check; `project/hostname-remove-requested`), and
// the processor's answer lands in the live state.
import { useState, type FormEvent } from "react";
import { createFileRoute, getRouteApi, useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { z } from "zod";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@iterate-com/ui/components/alert-dialog";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@iterate-com/ui/components/field";
import { Identifier } from "@iterate-com/ui/components/identifier";
import { Input } from "@iterate-com/ui/components/input";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@iterate-com/ui/components/sheet";
import { useContextStub, useFacetLiveState } from "../../../../lib/context-stub.ts";

const shell = getRouteApi("/_auth");

/** The project facet's live state, the one field this page reads. */
const HostnamesLive = z.looseObject({
  hostnames: z
    .record(
      z.string(),
      z.object({
        requested: z.object({ verb: z.enum(["add", "remove"]), offset: z.number() }).nullable(),
        cloudflare: z
          .object({
            status: z.string(),
            sslStatus: z.string(),
            records: z.array(z.object({ type: z.string(), name: z.string(), value: z.string() })),
            errors: z.array(z.string()),
          })
          .nullable(),
        error: z.string().nullable(),
      }),
    )
    .default({}),
});
type Hostname = z.infer<typeof HostnamesLive>["hostnames"][string];

export const Route = createFileRoute("/_auth/projects/$slug/hostnames")({
  validateSearch: z.object({ add: z.literal(1).optional().catch(undefined) }),
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
  const hostnames = Object.entries(HostnamesLive.safeParse(live.value).data?.hostnames ?? {});
  const [error, setError] = useState<string | null>(null);
  /** Append one hostname request to the project's root; the answer arrives in the live state. */
  const request = async (verb: "add" | "remove", hostname: string) => {
    setError(null);
    try {
      await context!.append({
        type: `events.iterate.com/project/hostname-${verb}-requested`,
        payload: { hostname },
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    }
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
          Serve this project's site on a domain of your own. Add the hostname here, then point it at
          us with the DNS record shown: it goes live, with a certificate, once the record is seen.
        </p>
      </div>
      {error && (
        <p role="alert" data-type="error" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {hostnames.length === 0 ? (
        <p className="text-sm text-muted-foreground">No hostnames yet.</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border" data-testid="hostnames">
          {hostnames.map(([hostname, entry]) => (
            <HostnameRow
              key={hostname}
              hostname={hostname}
              entry={entry}
              onCheck={() => void request("add", hostname).catch(() => {})}
              onRemove={() => void request("remove", hostname).catch(() => {})}
            />
          ))}
        </ul>
      )}
      <Sheet
        open={search.add === 1}
        onOpenChange={(open) => !open && void navigate({ search: {}, replace: true })}
      >
        <SheetContent side="right" className="data-[side=right]:sm:max-w-md">
          <AddHostnameForm
            onAdd={async (hostname) => {
              await request("add", hostname);
              await navigate({ search: {}, replace: true });
            }}
          />
        </SheetContent>
      </Sheet>
    </div>
  );
}

/** Where a hostname stands, in a word: what the processor owes, its refusal, or Cloudflare's status. */
function statusOf(entry: Hostname): {
  label: string;
  variant: "secondary" | "destructive" | "default";
} {
  if (entry.requested?.verb === "remove") return { label: "Removing…", variant: "secondary" };
  if (entry.requested) return { label: "Checking…", variant: "secondary" };
  if (entry.error && !entry.cloudflare) return { label: "Failed", variant: "destructive" };
  if (entry.cloudflare?.status === "active" && entry.cloudflare.sslStatus === "active")
    return { label: "Live", variant: "default" };
  return { label: "Waiting for DNS", variant: "secondary" };
}

function HostnameRow({
  hostname,
  entry,
  onCheck,
  onRemove,
}: {
  hostname: string;
  entry: Hostname;
  onCheck: () => void;
  onRemove: () => void;
}) {
  const status = statusOf(entry);
  const [cname] = entry.cloudflare?.records ?? [];
  const live = status.label === "Live";
  return (
    <li className="flex flex-col gap-4 p-4" data-hostname={hostname}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {live ? (
            <a href={`https://${hostname}`} target="_blank" rel="noreferrer" className="font-mono">
              {hostname}
            </a>
          ) : (
            <span className="font-mono">{hostname}</span>
          )}
          <Badge variant={status.variant}>{status.label}</Badge>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={Boolean(entry.requested)} onClick={onCheck}>
            {entry.error && !entry.cloudflare ? "Retry" : "Check again"}
          </Button>
          <AlertDialog>
            <AlertDialogTrigger
              render={<Button variant="outline" size="sm" />}
              disabled={entry.requested?.verb === "remove"}
            >
              Remove
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Remove {hostname}?</AlertDialogTitle>
                <AlertDialogDescription>
                  The project stops answering on it, and its certificate is dropped. You can add it
                  again later.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={onRemove}>Remove</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
      {entry.error && (
        <p role="alert" className="text-sm text-destructive">
          {entry.error}
        </p>
      )}
      {cname && !live && (
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-muted-foreground">
            At your DNS provider, add this record. On a bare domain (<code>example.com</code>), use
            your provider's ALIAS, ANAME or CNAME flattening.
          </p>
          <DnsRecord record={cname} />
          {entry.cloudflare?.errors.map((message) => (
            <p key={message} className="text-xs text-muted-foreground">
              Cloudflare: {message}
            </p>
          ))}
        </div>
      )}
    </li>
  );
}

function DnsRecord({ record }: { record: { type: string; name: string; value: string } }) {
  return (
    <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[4rem_1fr]">
      <dt className="text-muted-foreground">Type</dt>
      <dd className="font-mono">{record.type}</dd>
      <dt className="text-muted-foreground">Name</dt>
      <dd>
        <Identifier value={record.name} />
      </dd>
      <dt className="text-muted-foreground">Value</dt>
      <dd>
        <Identifier value={record.value} />
      </dd>
    </dl>
  );
}

function AddHostnameForm({ onAdd }: { onAdd: (hostname: string) => Promise<void> }) {
  const [pending, setPending] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const hostname = String(new FormData(event.currentTarget).get("hostname") ?? "")
      .trim()
      .toLowerCase()
      .replace(/\.$/, "");
    setPending(true);
    try {
      await onAdd(hostname);
    } finally {
      setPending(false);
    }
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="flex h-full flex-col">
      <SheetHeader>
        <SheetTitle>Add hostname</SheetTitle>
        <SheetDescription>
          A domain or subdomain you control. The DNS record to add is shown once it is set up.
        </SheetDescription>
      </SheetHeader>
      <FieldGroup className="px-4">
        <Field>
          <FieldLabel htmlFor="hostname">Hostname</FieldLabel>
          <Input
            id="hostname"
            name="hostname"
            placeholder="www.example.com"
            autoComplete="off"
            required
          />
          <FieldDescription>Without https:// or a path.</FieldDescription>
        </Field>
      </FieldGroup>
      <SheetFooter>
        <Button type="submit" disabled={pending}>
          {pending ? "Adding…" : "Add hostname"}
        </Button>
        <SheetClose render={<Button variant="outline" />}>Cancel</SheetClose>
      </SheetFooter>
    </form>
  );
}
