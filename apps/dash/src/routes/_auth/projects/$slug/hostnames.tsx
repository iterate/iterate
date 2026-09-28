// /projects/<slug>/hostnames — the project's own hostnames: `iterate.example.com` serves the project's
// site and `<app>.iterate.example.com` its apps. The `project` facet's LIVE STATE on `/` is the list
// (apps/os/src/project/contract.ts `hostnames`): what the processor still owes, Cloudflare's status
// and the CNAMEs the owner adds, and which live hostname is primary. Every act appends ONE event to
// the root — add (`?add=1`, a sheet), check, remove, make primary — and the processor's answer lands
// in the live state.
//
// A hostname that is not live yet shows the three steps to live, each ticked from Cloudflare's own
// words: DNS points at iterate (the custom hostname is `active`), the certificate is issued (its SSL
// is `active`), live. Where the owner's DNS provider speaks Domain Connect and has our template, the
// first step is one click (apps/os src/project/domain-connect.ts): "Connect with <provider>", and the
// provider sends the browser back with `?connected=<hostname>`, which checks it at once. While a
// hostname is on its way the page checks it again every CHECK_EVERY_MS, so nobody has to.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { createFileRoute, getRouteApi, useNavigate } from "@tanstack/react-router";
import { CheckIcon, Plus } from "lucide-react";
import { z } from "zod";
import { Button, buttonVariants } from "@iterate-com/ui/components/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@iterate-com/ui/components/field";
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
import { cn } from "cn";
import { useContextStub, useFacetLiveState } from "iterate/react";
import { DNS_PROVIDER_GUIDES, type DnsProviderGuide } from "../../../../lib/dns-provider-guides.ts";

const shell = getRouteApi("/_auth");

/** How often a hostname on its way to live is checked again while this page is open (Cloudflare
 *  usually needs a few minutes for the certificate); at most 40 times per page load. */
const CHECK_EVERY_MS = 30_000;

/** The project facet's live state, the fields this page reads. */
const HostnamesLive = z.looseObject({
  primaryHostname: z.string().nullable(),
  hostnames: z.record(
    z.string(),
    z.object({
      requested: z.object({ verb: z.enum(["add", "remove"]) }).nullable(),
      cloudflare: z
        .object({
          status: z.string(),
          sslStatus: z.string(),
          records: z.array(z.object({ name: z.string(), value: z.string() })),
          connect: z.object({ provider: z.string(), url: z.string() }).nullish(),
          dnsProvider: z.string().nullish(),
        })
        .nullable(),
      error: z.string().nullable(),
    }),
  ),
});
type Hostname = z.infer<typeof HostnamesLive>["hostnames"][string];

/** Whether a hostname serves: Cloudflare says its hostname and its certificate are both active. */
const isLive = (entry: Hostname) =>
  entry.cloudflare?.status === "active" && entry.cloudflare.sslStatus === "active";

/** Where a hostname stands, in the words and the one dot the row shows. */
function standingOf(entry: Hostname) {
  const dns = entry.cloudflare?.status === "active";
  if (entry.requested?.verb === "remove") return { label: "Removing…", dot: "bg-muted-foreground" };
  if (!entry.cloudflare && entry.requested)
    return { label: "Adding…", dot: "bg-amber-500 motion-safe:animate-pulse" };
  if (entry.error && !entry.cloudflare) return { label: "Failed", dot: "bg-destructive" };
  if (isLive(entry)) return { label: "Live", dot: "bg-emerald-500" };
  return {
    label: !dns ? "Waiting for DNS" : "Issuing certificate",
    dot: "bg-amber-500 motion-safe:animate-pulse",
  };
}

export const Route = createFileRoute("/_auth/projects/$slug/hostnames")({
  validateSearch: z.object({
    add: z.literal(1).optional().catch(undefined),
    /** the hostname a Domain Connect provider just wrote the records for */
    connected: z.string().optional().catch(undefined),
  }),
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
  const read = live.value ? HostnamesLive.safeParse(live.value) : undefined;
  const hostnames = Object.entries(read?.data?.hostnames || {});
  const primaryHostname = read?.data?.primaryHostname || null;
  const loadError = live.error || (read?.error && z.prettifyError(read.error));
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
  // back from the DNS provider: check the hostname it wrote the records for, once — only one the
  // project already has, so a crafted link can do no more than check it again. The query is cleared
  // once the check is asked; a failed ask can be retried (the guard is only held while in flight).
  const checkingConnected = useRef<string | null>(null);
  const connectedIsOurs = Boolean(search.connected && read?.data?.hostnames[search.connected]);
  useEffect(() => {
    const hostname = search.connected;
    if (!context || !hostname || !connectedIsOurs || checkingConnected.current === hostname) return;
    checkingConnected.current = hostname;
    context
      .append({ type: "events.iterate.com/project/hostname-add-requested", payload: { hostname } })
      .then(
        () => navigate({ search: {}, replace: true }),
        (caught: unknown) => {
          checkingConnected.current = null;
          setError(caught instanceof Error ? caught.message : String(caught));
        },
      );
  }, [context, search.connected, connectedIsOurs, navigate]);
  // on its way to live: check again every CHECK_EVERY_MS while the page is visible — each check is
  // the same `hostname-add-requested` "Check again" appends, answered in the live state
  const waiting = hostnames
    .filter(([, entry]) => entry.cloudflare && !entry.requested && !isLive(entry))
    .map(([hostname]) => hostname)
    .join(" ");
  const automaticChecks = useRef(0);
  useEffect(() => {
    if (!context || !waiting) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (automaticChecks.current >= 40) return clearInterval(timer);
      automaticChecks.current += 1;
      for (const hostname of waiting.split(" "))
        void context.append({
          type: "events.iterate.com/project/hostname-add-requested",
          payload: { hostname },
        });
    }, CHECK_EVERY_MS);
    return () => clearInterval(timer);
  }, [context, waiting]);
  const [pending, setPending] = useState(false);
  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const hostname = String(new FormData(event.currentTarget).get("hostname"));
    setPending(true);
    try {
      await request("add", hostname.trim().toLowerCase().replace(/\.$/, ""));
      await navigate({ search: {}, replace: true });
    } finally {
      setPending(false);
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
          Serve this project on a domain of your own: <code>iterate.example.com</code> is its site,
          and <code>&lt;app&gt;.iterate.example.com</code> each of its apps.
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {loadError ? (
        <p role="alert" className="text-sm text-destructive">
          Couldn't load this project's hostnames: {loadError}
        </p>
      ) : !read ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : hostnames.length === 0 ? (
        <p className="text-sm text-muted-foreground">No hostnames yet.</p>
      ) : (
        <ul className="flex flex-col divide-y" data-testid="hostnames">
          {hostnames.map(([hostname, entry]) => (
            <HostnameRow
              key={hostname}
              hostname={hostname}
              entry={entry}
              primary={hostname === primaryHostname}
              onCheck={() => void request("add", hostname)}
              onRemove={() => void request("remove", hostname)}
              onPrimary={(on) => void configurePrimary(on ? hostname : null)}
            />
          ))}
        </ul>
      )}
      <Sheet
        open={search.add === 1}
        onOpenChange={(open) => !open && !pending && void navigate({ search: {}, replace: true })}
      >
        <SheetContent
          side="right"
          className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-md"
        >
          <form onSubmit={(event) => void add(event)} className="flex h-full flex-col">
            <SheetHeader>
              <SheetTitle>Add hostname</SheetTitle>
              <SheetDescription>
                A subdomain you control, like <code>iterate.example.com</code>. Its apps get one
                label more: <code>notes.iterate.example.com</code>.
              </SheetDescription>
            </SheetHeader>
            <FieldGroup className="flex-1 p-4">
              <Field>
                <FieldLabel htmlFor="hostname">Hostname</FieldLabel>
                <Input
                  id="hostname"
                  name="hostname"
                  placeholder="iterate.example.com"
                  autoComplete="off"
                  required
                />
                <FieldDescription>
                  Next you point it at iterate: one click if your DNS is on Cloudflare, otherwise
                  three CNAME records we show you. The certificate follows by itself.
                </FieldDescription>
              </Field>
            </FieldGroup>
            <SheetFooter className="border-t sm:flex-row sm:justify-end">
              <SheetClose render={<Button variant="outline" type="button" />}>Cancel</SheetClose>
              <Button type="submit" disabled={pending}>
                {pending ? "Adding…" : "Add hostname"}
              </Button>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>
    </div>
  );
}

/** One hostname: its dot and standing, its actions, and — until it is live — the steps there. */
function HostnameRow({
  hostname,
  entry,
  primary,
  onCheck,
  onRemove,
  onPrimary,
}: {
  hostname: string;
  entry: Hostname;
  primary: boolean;
  onCheck: () => void;
  onRemove: () => void;
  onPrimary: (on: boolean) => void;
}) {
  const standing = standingOf(entry);
  const live = isLive(entry);
  const dns = entry.cloudflare?.status === "active";
  return (
    <li className="flex flex-col gap-4 py-4" data-hostname={hostname}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span aria-hidden className={cn("size-2 shrink-0 rounded-full", standing.dot)} />
          {live ? (
            <a
              href={`https://${hostname}`}
              target="_blank"
              rel="noreferrer"
              className="truncate font-mono hover:underline"
            >
              {hostname}
            </a>
          ) : (
            <span className="truncate font-mono">{hostname}</span>
          )}
          <span className="text-sm text-muted-foreground">
            {standing.label}
            {primary && " · primary"}
          </span>
        </div>
        <div className="flex gap-2">
          {live && (
            <Button variant="ghost" size="sm" onClick={() => onPrimary(!primary)}>
              {primary ? "Clear primary" : "Make primary"}
            </Button>
          )}
          {standing.label === "Failed" && (
            <Button variant="outline" size="sm" onClick={onCheck}>
              Try again
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={entry.requested?.verb === "remove"}
            onClick={onRemove}
          >
            Remove
          </Button>
        </div>
      </div>
      {entry.error && <p className="pl-4.5 text-sm text-destructive">{entry.error}</p>}
      {entry.cloudflare && !live && entry.requested?.verb !== "remove" && (
        <ol className="flex flex-col gap-4 pl-4.5">
          <Step done={dns} title="Point DNS at iterate">
            {!dns && (
              <div className="flex flex-col gap-3">
                {entry.cloudflare.connect && (
                  <div className="flex flex-col gap-1">
                    <a
                      href={entry.cloudflare.connect.url}
                      className={buttonVariants({ className: "self-start" })}
                    >
                      Connect with {entry.cloudflare.connect.provider}
                    </a>
                    <p className="text-xs text-muted-foreground">
                      {entry.cloudflare.connect.provider} shows you the records and adds them when
                      you approve. Nothing else changes.
                    </p>
                  </div>
                )}
                <ManualRecords
                  records={entry.cloudflare.records}
                  guide={DNS_PROVIDER_GUIDES[entry.cloudflare.dnsProvider || ""]}
                  alternative={Boolean(entry.cloudflare.connect)}
                />
              </div>
            )}
          </Step>
          <Step done={entry.cloudflare.sslStatus === "active"} title="Issue the certificate">
            {dns && (
              <p className="text-sm text-muted-foreground">
                Cloudflare is issuing a certificate for <code>{hostname}</code> and{" "}
                <code>*.{hostname}</code>. This usually takes a few minutes.
              </p>
            )}
          </Step>
          <Step done={false} title="Live">
            <p className="text-sm text-muted-foreground">
              {entry.requested ? "Checking…" : "Checked automatically while this page is open."}{" "}
              {!entry.requested && (
                <button type="button" className="underline" onClick={onCheck}>
                  Check now
                </button>
              )}
            </p>
          </Step>
        </ol>
      )}
    </li>
  );
}

/** One step to live: a ring, filled with a check once done, its title, and what to do while not. */
function Step({
  done,
  title,
  children,
}: {
  done: boolean;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <li className="flex gap-3" data-done={done ? "true" : undefined}>
      <span
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border",
          done ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/30",
        )}
      >
        {done && <CheckIcon aria-hidden className="size-3.5" />}
      </span>
      <div className="flex min-w-0 flex-col gap-2">
        <p className={cn("text-sm font-medium", done && "text-muted-foreground")}>{title}</p>
        {!done && children}
      </div>
    </li>
  );
}

/** The three CNAMEs to add by hand — with the owner's DNS provider's own clicks when we know it
 *  (lib/dns-provider-guides.ts), else plainly. `alternative`: shown under a Connect button. */
function ManualRecords({
  records,
  guide,
  alternative,
}: {
  records: { name: string; value: string }[];
  guide: DnsProviderGuide | undefined;
  alternative: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">
        {alternative ? "Or add these records yourself" : "Add these records"}
        {guide ? (
          <>
            {" "}
            in{" "}
            <a href={guide.url} target="_blank" rel="noreferrer" className="underline">
              {guide.name}
            </a>
            :
          </>
        ) : (
          " at your DNS provider (on Cloudflare, set them to DNS only):"
        )}
      </p>
      {guide && (
        <ol className="flex list-decimal flex-col gap-0.5 pl-5 text-sm text-muted-foreground">
          {guide.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      )}
      <table className="w-full text-left font-mono text-xs">
        <tbody>
          {records.map((record) => (
            <tr key={record.name} className="align-top">
              <td className="py-0.5 pr-4 break-all">{record.name}</td>
              <td className="py-0.5 pr-4 text-muted-foreground">CNAME</td>
              <td className="py-0.5 break-all">
                {guide?.trailingDot ? `${record.value}.` : record.value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {guide?.notes?.map((note) => (
        <p key={note} className="text-xs text-muted-foreground">
          {note}
        </p>
      ))}
    </div>
  );
}
