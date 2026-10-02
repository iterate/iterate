// /projects/<slug>/domains — where the project is served. First its DEFAULT DOMAIN under the
// deployment's ingress (`projectHostOf`), which always works and can't be removed: primary until
// another is made primary, then a page visit on it redirects there (core/os
// primary-hostname-redirect.ts), and its apps' addresses show which routing the deployment uses.
// Then the project's own hostnames: `iterate.example.com` serves the project's
// site and `<app>.iterate.example.com` its apps. The `project` facet's LIVE STATE on `/` is the list
// (core/os/src/project/contract.ts `hostnames`): what the processor still owes, Cloudflare's status
// and the CNAMEs the owner adds, and which live hostname is primary. Every act appends ONE event to
// the root — add (`?add=1`, a sheet), check, remove, make primary — and the processor's answer lands
// in the live state.
//
// A hostname that is not live yet shows the three steps to live, each ticked from Cloudflare's own
// words: DNS points at iterate (the custom hostname is `active`), the certificate is issued (its SSL
// is `active`), live. Where the owner's DNS provider speaks Domain Connect and has our template, the
// first step is one click (core/os src/project/domain-connect.ts): "Connect with <provider>", and the
// provider sends the browser back with `?connected=<hostname>`, which checks it at once. While a
// hostname is on its way the page checks it again every CHECK_EVERY_MS, so nobody has to.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { createFileRoute, getRouteApi, useNavigate } from "@tanstack/react-router";
import { LoaderCircleIcon, Plus } from "lucide-react";
import { z } from "zod";
import { Button, buttonVariants } from "@iterate-com/ui/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@iterate-com/ui/components/ui/field";
import { Input } from "@iterate-com/ui/components/ui/input";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@iterate-com/ui/components/ui/sheet";
import { cn } from "cn";
import { useContextStub, useFacetLiveState } from "iterate/react";
import type { IngressRouting } from "iterate/project-ingress";
import { DNS_PROVIDER_GUIDES, type DnsProviderGuide } from "../../../../lib/dns-provider-guides.ts";
import { projectHostOf } from "../../../../lib/origins.ts";

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
          records: z.array(
            z.object({ type: z.string().default("CNAME"), name: z.string(), value: z.string() }),
          ),
          connect: z.object({ provider: z.string(), url: z.string() }).nullish(),
          dns: z.object({ zone: z.string(), provider: z.string().nullable() }).nullish(),
        })
        .nullable(),
      error: z.string().nullable(),
      connectedAt: z.string().nullish(),
      /** the project holds the hostname: its ownership record named the project */
      claimed: z.boolean().default(false),
    }),
  ),
});
type Hostname = z.infer<typeof HostnamesLive>["hostnames"][string];

/** Whether a hostname serves: the project holds it, and Cloudflare says its hostname and its
 *  certificate are both active. */
const isLive = (entry: Hostname) =>
  entry.claimed && entry.cloudflare?.status === "active" && entry.cloudflare.sslStatus === "active";

/** Whether the owner came back from their DNS provider having approved the records in the last
 *  ten minutes: long enough for them to be seen, and a crafted or failed return can't hide the
 *  setup for longer. */
const recentlyConnected = (entry: Hostname) =>
  Boolean(entry.connectedAt && Date.now() - Date.parse(entry.connectedAt) < 10 * 60_000);

/** Where a hostname stands, in the one word and the one dot its row shows: a pulsing dot while
 *  something is on its way, a still one while it waits on the owner. */
function standingOf(entry: Hostname) {
  const waiting = "bg-amber-500 motion-safe:animate-pulse";
  if (entry.requested?.verb === "remove") return { label: "Removing…", dot: "bg-muted-foreground" };
  if (!entry.cloudflare && entry.requested) return { label: "Adding…", dot: waiting };
  if (entry.error && !entry.cloudflare) return { label: "Failed", dot: "bg-destructive" };
  if (isLive(entry)) return { label: "Live", dot: "bg-emerald-500" };
  if (entry.cloudflare?.status === "active" && !entry.claimed)
    return { label: "Prove it's yours", dot: "bg-amber-500" };
  if (entry.cloudflare?.status === "active") return { label: "Issuing certificate", dot: waiting };
  if (recentlyConnected(entry)) return { label: "Waiting for DNS", dot: waiting };
  return { label: "Connect your DNS", dot: "bg-amber-500" };
}

export const Route = createFileRoute("/_auth/projects/$slug/domains")({
  validateSearch: z.object({
    add: z.literal(1).optional().catch(undefined),
    /** the hostname a Domain Connect provider just wrote the records for */
    connected: z.string().optional().catch(undefined),
    /** what the provider said when it wrote nothing (Domain Connect's redirect: a cancel, a failure) */
    error: z.string().optional().catch(undefined),
    error_description: z.string().optional().catch(undefined),
  }),
  staticData: { page: "Domains" },
  head: ({ params }) => ({ meta: [{ title: `Domains · ${params.slug} · Dash` }] }),
  component: ProjectDomains,
});

function ProjectDomains() {
  const { project } = Route.useRouteContext();
  const { api, info } = shell.useRouteContext();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const context = useContextStub(() => api.projects.get(project.id), [api, project.id]).stub;
  const live = useFacetLiveState(context, "project");
  const read = live.value ? HostnamesLive.safeParse(live.value) : undefined;
  const hostnames = Object.entries(read?.data?.hostnames || {});
  const primaryHostname = read?.data?.primaryHostname || null;
  const defaultSite = projectHostOf(info, project.slug);
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
    // a cancel or a failure at the provider comes back with `error`: nothing was written
    if (search.error)
      setError(
        `Your DNS provider added no records for ${hostname}: ${search.error_description || search.error}.`,
      );
    context
      .append({
        type: "events.iterate.com/project/hostname-add-requested",
        payload: { hostname, connected: !search.error },
      })
      .then(
        () => navigate({ search: {}, replace: true }),
        (caught: unknown) => {
          checkingConnected.current = null;
          setError(caught instanceof Error ? caught.message : String(caught));
        },
      );
  }, [
    context,
    search.connected,
    search.error,
    search.error_description,
    connectedIsOurs,
    navigate,
  ]);
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
          <h1 className="text-2xl font-semibold tracking-tight">Domains</h1>
          <Button disabled={!context} onClick={() => void navigate({ search: { add: 1 } })}>
            <Plus data-icon="inline-start" />
            Add domain
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
      {loadError && (
        <p role="alert" className="text-sm text-destructive">
          Couldn't load this project's domains: {loadError}
        </p>
      )}
      <ul className="flex flex-col divide-y" data-testid="domains">
        {defaultSite && (
          <DefaultDomainRow
            site={defaultSite}
            routing={info.ingressRouting}
            primary={Boolean(read?.data) && !primaryHostname}
            primaryHostname={primaryHostname}
            onPrimary={() => void configurePrimary(null)}
          />
        )}
        {!read && !loadError && <li className="py-5 text-sm text-muted-foreground">Loading…</li>}
        {hostnames.map(([hostname, entry]) => (
          <HostnameRow
            key={hostname}
            hostname={hostname}
            entry={entry}
            primary={hostname === primaryHostname}
            onCheck={() => void request("add", hostname)}
            onAdd={(other) => void request("add", other)}
            onRemove={() => void request("remove", hostname)}
            onPrimary={(on) => void configurePrimary(on ? hostname : null)}
          />
        ))}
      </ul>
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
              <SheetTitle>Add domain</SheetTitle>
              <SheetDescription>
                A domain or subdomain you control, like <code>example.com</code> or{" "}
                <code>iterate.example.com</code>. Its apps get one label more:{" "}
                <code>notes.iterate.example.com</code>.
              </SheetDescription>
            </SheetHeader>
            <FieldGroup className="flex-1 p-4">
              <Field>
                <FieldLabel htmlFor="hostname">Domain</FieldLabel>
                <Input
                  id="hostname"
                  name="hostname"
                  placeholder="iterate.example.com"
                  autoComplete="off"
                  required
                />
                <FieldDescription>
                  Next you point it at iterate: one click where your DNS provider supports it,
                  otherwise a few records we show you, with where to put them. The certificate
                  follows by itself.
                </FieldDescription>
              </Field>
            </FieldGroup>
            <SheetFooter className="border-t sm:flex-row sm:justify-end">
              <SheetClose render={<Button variant="outline" type="button" />}>Cancel</SheetClose>
              <Button type="submit" disabled={pending}>
                {pending ? "Adding…" : "Add domain"}
              </Button>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>
    </div>
  );
}

/** The project's default domain under the deployment's ingress: always live, never removable, the
 *  primary until one of the project's own hostnames is — then a page visit on it redirects there
 *  (subdomains routing only; paths routing shares the platform's origin and never redirects). Its
 *  apps' address says which routing the deployment uses. */
function DefaultDomainRow({
  site,
  routing,
  primary,
  primaryHostname,
  onPrimary,
}: {
  site: string;
  routing: IngressRouting;
  /** the live state has loaded and no hostname of the project's own is primary */
  primary: boolean;
  primaryHostname: string | null;
  onPrimary: () => void;
}) {
  const url = new URL(site);
  const shown = `${url.host}${url.pathname.replace(/\/$/, "")}`;
  const redirects = Boolean(primaryHostname) && routing?.type === "subdomains";
  return (
    <li className="flex flex-col gap-2 py-5" data-hostname={url.host}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex max-w-full min-w-0 items-center gap-3">
          <span aria-hidden className="size-2 shrink-0 rounded-full bg-emerald-500" />
          <a
            href={site}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 truncate font-mono text-base hover:underline"
          >
            {shown}
          </a>
        </span>
        <span className="text-sm text-muted-foreground">
          Live · default{primary && " · primary"}
        </span>
        {primaryHostname && (
          <div className="ml-auto flex gap-1">
            <Button variant="ghost" size="sm" onClick={onPrimary}>
              Make primary
            </Button>
          </div>
        )}
      </div>
      <div className="flex max-w-2xl flex-col gap-1 pl-5 text-sm text-muted-foreground">
        <p>
          Always works and can't be removed.
          {redirects && (
            <>
              {" "}
              Page visits redirect to <code>{primaryHostname}</code>, the primary.
            </>
          )}
        </p>
        <p>
          {routing?.type === "subdomains" ? (
            <>
              Hostname routing: each app is at <code>&lt;app&gt;--{url.host}</code>.
            </>
          ) : (
            <>
              Path routing: each app is at <code>{shown}/&lt;app&gt;</code>.
            </>
          )}
        </p>
      </div>
    </li>
  );
}

/** One hostname: its dot and standing and its actions, and — until it is live — where it is on
 *  the way (DNS, certificate, live) and the one thing to do next, or what it is waiting for. */
function HostnameRow({
  hostname,
  entry,
  primary,
  onCheck,
  onAdd,
  onRemove,
  onPrimary,
}: {
  hostname: string;
  entry: Hostname;
  primary: boolean;
  onCheck: () => void;
  onAdd: (hostname: string) => void;
  onRemove: () => void;
  onPrimary: (on: boolean) => void;
}) {
  const standing = standingOf(entry);
  const live = isLive(entry);
  const cloudflare = entry.cloudflare;
  const dns = cloudflare?.status === "active";
  const zone = cloudflare?.dns?.zone;
  const guide = DNS_PROVIDER_GUIDES[cloudflare?.dns?.provider || ""];
  // a bare domain at a provider that cannot point its root at another name
  const apexNotPossible = zone === hostname && guide?.apex === false && !cloudflare?.connect;
  return (
    <li className="flex flex-col gap-4 py-5" data-hostname={hostname}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex max-w-full min-w-0 items-center gap-3">
          <span aria-hidden className={cn("size-2 shrink-0 rounded-full", standing.dot)} />
          {live ? (
            <a
              href={`https://${hostname}`}
              target="_blank"
              rel="noreferrer"
              className="min-w-0 truncate font-mono text-base hover:underline"
            >
              {hostname}
            </a>
          ) : (
            <span className="min-w-0 truncate font-mono text-base">{hostname}</span>
          )}
        </span>
        <span className="text-sm text-muted-foreground">
          {standing.label}
          {primary && " · primary"}
        </span>
        <div className="ml-auto flex gap-1">
          {live && !primary && (
            <Button variant="ghost" size="sm" onClick={() => onPrimary(true)}>
              Make primary
            </Button>
          )}
          {standing.label === "Failed" && (
            <Button variant="ghost" size="sm" onClick={onCheck}>
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
      {entry.error && <p className="pl-5 text-sm text-destructive">{entry.error}</p>}
      {cloudflare && !live && entry.requested?.verb !== "remove" && (
        <div className="flex max-w-2xl flex-col gap-4 pl-5">
          <Progress dns={dns} certificate={cloudflare.sslStatus === "active"} />
          {dns && !entry.claimed ? (
            <div className="flex flex-col gap-3">
              <p className="text-[15px]">
                One record left: it proves <code>{hostname}</code> is yours, so no other project can
                take it.
              </p>
              <ManualRecords
                records={cloudflare.records.filter((record) => record.type === "TXT")}
                zone={zone}
                guide={guide}
              />
              <p className="text-sm text-muted-foreground">
                Checked every 30 seconds while this page is open.{" "}
                <CheckNow onCheck={onCheck} checking={Boolean(entry.requested)} />
              </p>
            </div>
          ) : dns ? (
            <Waiting
              lead={
                <>
                  Issuing a certificate for <code>{hostname}</code> and <code>*.{hostname}</code>.
                </>
              }
              detail="Usually two to five minutes. Nothing for you to do."
            />
          ) : recentlyConnected(entry) ? (
            <Waiting
              lead={`${cloudflare.connect?.provider || "Your DNS provider"} added the records at ${new Date(entry.connectedAt!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`}
              detail={
                <>
                  Waiting for them to be seen, usually under a minute.{" "}
                  <CheckNow onCheck={onCheck} checking={Boolean(entry.requested)} />
                </>
              }
            />
          ) : apexNotPossible ? (
            <div className="flex flex-col gap-3">
              <p className="text-[15px]">
                {guide.name} can't point a bare domain like <code>{hostname}</code> at another name.
              </p>
              <p className="text-sm text-muted-foreground">
                Use a subdomain instead, or move {hostname}'s DNS to a provider with CNAME
                flattening (Cloudflare's is free).
              </p>
              <Button className="self-start" onClick={() => onAdd(`www.${hostname}`)}>
                Add www.{hostname} instead
              </Button>
            </div>
          ) : cloudflare.connect ? (
            <div className="flex flex-col gap-3">
              <p className="text-[15px]">
                {entry.connectedAt
                  ? `${cloudflare.connect.provider} hasn't shown the records yet. If you didn't approve them, connect again.`
                  : `${zone || hostname}'s DNS is on ${cloudflare.connect.provider}. Approve the records there and you're done.`}
              </p>
              <a
                href={cloudflare.connect.url}
                className={buttonVariants({ className: "self-start" })}
              >
                Connect with {cloudflare.connect.provider}
              </a>
              <details>
                <summary className="cursor-pointer text-sm text-muted-foreground">
                  Add the records yourself instead
                </summary>
                <div className="pt-3">
                  <ManualRecords records={cloudflare.records} zone={zone} guide={guide} />
                </div>
              </details>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-[15px]">
                {guide && zone
                  ? `${zone}'s DNS is on ${guide.name}. Add these records there.`
                  : "Add these records at your DNS provider."}
              </p>
              <ManualRecords records={cloudflare.records} zone={zone} guide={guide} />
              <p className="text-sm text-muted-foreground">
                Checked every 30 seconds while this page is open.{" "}
                <CheckNow onCheck={onCheck} checking={Boolean(entry.requested)} />
              </p>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** DNS → certificate → live, as three short bars: done ones dark, the current one half. */
function Progress({ dns, certificate }: { dns: boolean; certificate: boolean }) {
  const stages = [
    { label: "DNS", done: dns },
    { label: "Certificate", done: certificate },
    { label: "Live", done: false },
  ];
  const current = stages.findIndex((stage) => !stage.done);
  return (
    <ol
      className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
      aria-label="Progress"
    >
      {stages.map((stage, index) => (
        <li
          key={stage.label}
          className={cn("flex items-center gap-1.5", index <= current && "text-foreground")}
          aria-current={index === current ? "step" : undefined}
        >
          <span
            className={cn(
              "h-0.5 w-10 rounded-full bg-border",
              stage.done && "bg-foreground",
              index === current && "bg-gradient-to-r from-foreground from-50% to-border to-50%",
            )}
          />
          {stage.label}
        </li>
      ))}
    </ol>
  );
}

/** What the hostname is waiting for, with a spinner: nothing for the owner to do. */
function Waiting({ lead, detail }: { lead: React.ReactNode; detail: React.ReactNode }) {
  return (
    <div className="flex gap-3" role="status">
      <LoaderCircleIcon aria-hidden className="mt-1 size-4 shrink-0 motion-safe:animate-spin" />
      <div className="flex flex-col gap-1">
        <p className="text-[15px]">{lead}</p>
        <p className="text-sm text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

function CheckNow({ onCheck, checking }: { onCheck: () => void; checking: boolean }) {
  return checking ? (
    <span>Checking…</span>
  ) : (
    <button type="button" className="underline" onClick={onCheck}>
      Check now
    </button>
  );
}

/** The records to add by hand, named as the owner's DNS provider's form wants them — relative to
 *  the zone (`iterate`, `@` for the zone itself) when we know it — with that provider's own clicks
 *  when we know the provider (lib/dns-provider-guides.ts), a copy button per value. */
function ManualRecords({
  records,
  zone,
  guide,
}: {
  records: { type: string; name: string; value: string }[];
  zone: string | undefined;
  guide: DnsProviderGuide | undefined;
}) {
  const nameOf = (name: string) =>
    !zone
      ? name
      : name === zone
        ? "@"
        : name.endsWith(`.${zone}`)
          ? name.slice(0, -zone.length - 1)
          : name;
  return (
    <div className="flex flex-col gap-3">
      {guide && (
        <ol className="flex list-decimal flex-col gap-0.5 pl-5 text-sm text-muted-foreground">
          <li>
            <a href={guide.url} target="_blank" rel="noreferrer" className="underline">
              Open {guide.name}
            </a>
          </li>
          {guide.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground">
              <th className="pb-1.5 pr-4 font-medium">{zone ? "Name" : "Hostname"}</th>
              <th className="pb-1.5 pr-4 font-medium">Type</th>
              <th className="pb-1.5 font-medium">Value</th>
            </tr>
          </thead>
          <tbody className="font-mono text-[13px]">
            {records.map((record) => {
              // a target name takes the provider's final dot; a TXT record's text never does
              const value =
                guide?.trailingDot && record.type === "CNAME" ? `${record.value}.` : record.value;
              return (
                <tr key={record.name} className="border-t align-top">
                  <td className="py-2 pr-4 break-all">{nameOf(record.name)}</td>
                  <td className="py-2 pr-4 text-muted-foreground">{record.type}</td>
                  <td className="py-2 break-all">
                    {value}
                    <CopyButton text={value} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {records.some((record) => record.type === "TXT") && (
        <p className="text-xs text-muted-foreground">
          Add each record with the type it shows: the TXT record's value is its text, exactly as
          here.
        </p>
      )}
      {guide?.notes?.map((note) => (
        <p key={note} className="text-xs text-muted-foreground">
          {note}
        </p>
      ))}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ml-2 rounded border px-1.5 py-0.5 font-sans text-xs text-muted-foreground hover:text-foreground"
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
