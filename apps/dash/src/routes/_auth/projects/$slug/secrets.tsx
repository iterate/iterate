// /projects/<slug>/secrets — the project's secrets as `itx.secrets.list()` shows them: each one's
// path, the origins it may be sent to, its refresh strategy's kind and when it was first set — never
// a value — with an update and a delete per row. Setting one is a SHEET (the dash's form shape, like
// /projects' New project), opened by "New secret" (`?new=1`) or a row's Update (`?update=<name>`),
// so either is a deep link: a name (the path `/secrets/<name>` an outbound request's
// `getSecret("/secrets/<name>")` placeholder spells), a value (a string, or a JSON object whose
// fields the placeholder's `{ field }` picks) and the origins the value may be sent to. Update is
// the same sheet on an existing row: the name locked, the pin pre-filled, the value pasted again —
// the current one is never shown, and a pin only ever enters together with the value it guards (the
// platform has no verb that changes a pin alone). An agent's collection link
// (`?collect=1&project&platform&path&urls&description&agent`, minted by `itx.secrets.collectFromUser`
// in apps/os/src/context/built-ins.ts) opens the same sheet only when its project and platform are
// this page's, with the path and origins locked; once the secret is set, the requesting agent is
// messaged. The list is the route's loader; a set or a delete invalidates the router, which reloads it.
import { useRef, useState, type FormEvent, type RefObject } from "react";
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { z } from "zod";
import type { AuthenticatedApp } from "iterate/next/app";
import type { SecretCatalogEntry } from "iterate/next/api";
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
import { Spinner } from "@iterate-com/ui/components/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@iterate-com/ui/components/table";
import { Textarea } from "@iterate-com/ui/components/textarea";

export const Route = createFileRoute("/_auth/projects/$slug/secrets")({
  // the sheet's state is the URL: `?new=1` sets a new secret, `?update=<name>` updates that one
  validateSearch: z.object({
    new: z.literal(1).optional().catch(undefined),
    update: z.string().optional().catch(undefined),
    collect: z.literal(1).optional().catch(undefined),
    project: z.string().optional().catch(undefined),
    platform: z.string().optional().catch(undefined),
    path: z.string().optional().catch(undefined),
    urls: z.array(z.string()).optional().catch(undefined),
    description: z.string().optional().catch(undefined),
    agent: z.string().optional().catch(undefined),
  }),
  loader: async ({ context }) => ({
    secrets: await context.api.projects.get(context.project.id).secrets.list(),
  }),
  head: ({ params }) => ({ meta: [{ title: `Secrets · ${params.slug} · Dash` }] }),
  component: ProjectSecrets,
});

/** The name's grammar, mirroring `SECRET_NAME` in apps/os/src/secrets.ts: `[a-zA-Z0-9._-]+`, never
 *  `.` or `..` — what `getSecret("/secrets/<name>")` can spell. Its source is the input's `pattern`,
 *  so the browser says so before the platform has to. The hyphen is escaped because browsers
 *  compile `pattern` with the `v` flag, where a bare `-` in a class is invalid and silently disables
 *  the check (https://html.spec.whatwg.org/multipage/input.html#the-pattern-attribute). */
const SECRET_NAME = /^(?!\.\.?$)[a-zA-Z0-9_\-.]+$/;
const SECRETS_PREFIX = "/secrets/";

function ProjectSecrets() {
  const { api, info, project } = Route.useRouteContext();
  const { secrets } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const router = useRouter();
  const [pending, setPending] = useState(false);
  // where the sheet lands focus: the value on an update (the name is locked), the name otherwise
  const valueField = useRef<HTMLTextAreaElement>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const closeSheet = () => navigate({ search: {}, replace: true });
  const collectionUrls = (() => {
    if (!search.urls) return null;
    const parsed = z.array(z.string().url()).safeParse(search.urls);
    if (!parsed.success || parsed.data.length === 0) return null;
    const origins = parsed.data.map((value) => new URL(value));
    if (
      origins.some(
        (url) =>
          !["http:", "https:"].includes(url.protocol) || Boolean(url.username || url.password),
      )
    )
      return null;
    return [...new Set(origins.map((url) => url.origin))];
  })();
  const collecting = search.collect === 1;
  const collectionTargetMatches =
    collecting && search.project === project.id && search.platform === info.platformOrigin;
  const collectionIsValid =
    collectionTargetMatches &&
    Boolean(
      search.path?.startsWith(SECRETS_PREFIX) &&
      SECRET_NAME.test(search.path.slice(SECRETS_PREFIX.length)),
    ) &&
    Boolean(collectionUrls) &&
    (!search.agent || search.agent.startsWith("/agents/"));
  /** The row `?update=<name>` names — none when the name is not (or no longer) a secret. */
  const updating =
    (!collecting &&
      search.update &&
      secrets.find((secret) => secret.path === SECRETS_PREFIX + search.update)) ||
    null;

  const deleteSecret = async (secretPath: string) => {
    setError(null);
    setStatus(null);
    setDeleting(secretPath);
    try {
      await api.projects.get(project.id).secrets.delete(secretPath);
      setStatus(`${secretPath} is deleted.`);
      await router.invalidate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 p-4 md:p-8">
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">Secrets</h1>
          <Button onClick={() => void navigate({ search: { new: 1 } })}>
            <Plus data-icon="inline-start" />
            New secret
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          A secret is its path. In a worker or a script, put{" "}
          <code>getSecret("/secrets/&lt;name&gt;")</code> in an outbound request's URL or headers:
          the platform substitutes the value as the request leaves, and only towards the origins
          pinned here. A value never comes back out.
        </p>
      </div>
      {error && (
        <p role="alert" data-type="error" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {status && (
        <p role="status" className="text-sm text-muted-foreground">
          {status}
        </p>
      )}
      {secrets.length === 0 ? (
        <p className="text-sm text-muted-foreground">No secrets yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table data-testid="secrets">
            <TableHeader>
              <TableRow>
                <TableHead>Path</TableHead>
                <TableHead>Sent to</TableHead>
                <TableHead>Refresh</TableHead>
                <TableHead>Set</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {secrets.map((secret) => (
                <TableRow key={secret.path}>
                  <TableCell>
                    <Identifier value={secret.path} />
                  </TableCell>
                  <TableCell>
                    <ul className="flex flex-col gap-0.5 font-mono text-xs">
                      {secret.urls.map((url) => (
                        <li key={url}>{url}</li>
                      ))}
                    </ul>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{secret.refresh || "—"}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(secret.createdAt).toISOString()}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-label={`Update ${secret.path}`}
                        onClick={() =>
                          void navigate({
                            search: { update: secret.path.slice(SECRETS_PREFIX.length) },
                          })
                        }
                      >
                        Update
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger
                          render={<Button variant="outline" size="sm" />}
                          aria-label={`Delete ${secret.path}`}
                          disabled={deleting === secret.path}
                        >
                          {deleting === secret.path ? "Deleting…" : "Delete"}
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete {secret.path}?</AlertDialogTitle>
                            <AlertDialogDescription>
                              The value is forgotten and requests that spell this placeholder fail
                              until it is set again. There is no undo.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => void deleteSecret(secret.path)}>
                              Delete
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {collecting && !collectionTargetMatches && (
        <p
          role="alert"
          data-type="error"
          className="rounded-lg border border-destructive p-4 text-sm text-destructive"
        >
          This collection link is for a different Iterate instance or project. It cannot write to
          the instance currently connected to Dash.
        </p>
      )}
      {collecting && collectionTargetMatches && !collectionIsValid && (
        <p
          role="alert"
          data-type="error"
          className="rounded-lg border border-destructive p-4 text-sm text-destructive"
        >
          This collection link is incomplete or invalid. Ask the requesting agent for a new link.
        </p>
      )}
      <Sheet
        open={collecting ? collectionIsValid : search.new === 1 || Boolean(search.update)}
        onOpenChange={(open) => {
          if (open || pending) return;
          void closeSheet();
        }}
      >
        <SheetContent
          side="right"
          showCloseButton={!pending}
          initialFocus={updating || collectionIsValid ? valueField : undefined}
          className="overflow-y-auto data-[side=right]:sm:max-w-md"
        >
          <SecretForm
            // mounted with the sheet, keyed by what it opens on, so every opening starts from its row
            key={collecting ? search.path || "collect" : search.update || "new"}
            api={api}
            projectId={project.id}
            secrets={secrets}
            initialName={
              collectionIsValid ? search.path!.slice(SECRETS_PREFIX.length) : search.update || ""
            }
            initialUrls={collectionIsValid ? collectionUrls!.join(" ") : undefined}
            description={collectionIsValid ? search.description : undefined}
            requestingAgent={collectionIsValid ? search.agent : undefined}
            collecting={collectionIsValid}
            expectedPlatformOrigin={search.platform}
            collectionTarget={
              collectionIsValid
                ? `${project.slug} on ${new URL(info.platformOrigin).host}`
                : undefined
            }
            updating={updating}
            valueField={valueField}
            pending={pending}
            setPending={setPending}
            onDone={async (message) => {
              setError(null);
              setStatus(message);
              await router.invalidate();
              await closeSheet();
            }}
          />
        </SheetContent>
      </Sheet>
    </div>
  );
}

/** The sheet's body: the name, the value and the pin — one `secrets.set`. On an existing row
 *  (`updating`) the name is locked and the pin pre-filled; the value is always typed here. */
function SecretForm({
  api,
  projectId,
  secrets,
  initialName,
  initialUrls,
  description,
  requestingAgent,
  collecting,
  expectedPlatformOrigin,
  collectionTarget,
  updating,
  valueField,
  pending,
  setPending,
  onDone,
}: {
  api: AuthenticatedApp["api"];
  projectId: string;
  secrets: SecretCatalogEntry[];
  initialName: string;
  initialUrls?: string;
  description?: string;
  requestingAgent?: string;
  collecting: boolean;
  expectedPlatformOrigin?: string;
  collectionTarget?: string;
  updating: SecretCatalogEntry | null;
  valueField: RefObject<HTMLTextAreaElement | null>;
  pending: boolean;
  setPending: (pending: boolean) => void;
  /** The secret is written: the line the page shows for it. */
  onDone: (message: string) => Promise<void>;
}) {
  const [name, setName] = useState(initialName);
  const [value, setValue] = useState("");
  const [urls, setUrls] = useState(updating ? updating.urls.join(" ") : initialUrls || "");
  const [error, setError] = useState<string | null>(null);
  const origins = urls.split(/[\s,]+/).filter(Boolean);
  const path = `${SECRETS_PREFIX}${name.trim()}`;
  const existing = secrets.find((secret) => secret.path === path);

  const setSecret = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    // the platform pins ORIGINS, so each entry must be a whole URL — said here, where it was typed
    const notAUrl = origins.find((origin) => !URL.canParse(origin));
    if (notAUrl) {
      setError(`"${notAUrl}" is not a URL — write the whole origin, like https://api.example.com`);
      return;
    }
    setPending(true);
    try {
      if (collecting && (await api.info()).platformOrigin !== expectedPlatformOrigin) {
        setError("This collection link is for a different Iterate instance or project.");
        return;
      }
      await api.projects.get(projectId).secrets.set(path, value, { urls: origins });
      let notification = "";
      if (requestingAgent) {
        try {
          await api.projects
            .get(projectId)
            .invoke([
              "itx",
              "agents",
              ["get", requestingAgent],
              ["message", `The user submitted the secret at ${path}. Its value was not included.`],
            ]);
        } catch {
          notification = " The secret was saved, but the requesting agent could not be notified.";
        }
      }
      await onDone(
        `${path} is ${existing ? "updated" : "set"}. The value is stored encrypted and is not shown again.${notification}`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={setSecret} className="flex h-full flex-col">
      <SheetHeader className="border-b">
        <SheetTitle>
          {updating ? `Update ${updating.path}` : collecting ? `Enter ${path}` : "New secret"}
        </SheetTitle>
        <SheetDescription>
          {description ||
            (updating
              ? "Paste the value again — the current one is never shown — and check the origins: a pin only ever changes together with the value it guards."
              : "Stored encrypted and never shown again; the log records who set what and when, never the value.")}
        </SheetDescription>
      </SheetHeader>
      <FieldGroup className="flex-1 p-4">
        <Field>
          <FieldLabel htmlFor="secret-name">Name</FieldLabel>
          <div className="flex items-center gap-1">
            <span className="font-mono text-sm text-muted-foreground">{SECRETS_PREFIX}</span>
            <Input
              id="secret-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              pattern={SECRET_NAME.source}
              title="Letters, digits, dots, underscores and dashes"
              placeholder="stripe"
              autoComplete="off"
              spellCheck={false}
              required
              readOnly={Boolean(updating || collecting)}
              className="font-mono read-only:bg-muted read-only:text-muted-foreground"
            />
          </div>
          <FieldDescription>
            {updating
              ? "A secret is its path; to move it, set a new name and delete this one."
              : collecting
                ? `This collection link writes to ${collectionTarget}.`
                : "Letters, digits, dots, underscores and dashes — the path is what the placeholder spells."}
          </FieldDescription>
        </Field>
        {collecting && existing && (
          <p role="note" className="text-sm text-muted-foreground">
            This replaces the existing secret, currently pinned to {existing.urls.join(", ")}. The
            requested origins below replace that pin with the new value.
          </p>
        )}
        <Field>
          <FieldLabel htmlFor="secret-value">{updating ? "New value" : "Value"}</FieldLabel>
          <Textarea
            id="secret-value"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="sk_live_…"
            autoComplete="off"
            spellCheck={false}
            required
            ref={valueField}
            rows={4}
            className="font-mono"
          />
          <FieldDescription>
            One string, or a JSON object — then{" "}
            <code>
              getSecret("/secrets/name", {"{"} field: "a.b" {"}"})
            </code>{" "}
            picks one of its fields.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="secret-urls">Sent to</FieldLabel>
          <Input
            id="secret-urls"
            value={urls}
            onChange={(event) => setUrls(event.target.value)}
            placeholder="https://api.stripe.com"
            autoComplete="off"
            spellCheck={false}
            required
            readOnly={collecting}
            className="font-mono"
          />
          <FieldDescription>
            The origins the value may be sent to, separated by spaces or commas. A request to any
            other host is refused, and the value is never sent there.
          </FieldDescription>
        </Field>
        {existing?.refresh && (
          <p role="note" className="text-sm text-muted-foreground">
            This secret refreshes itself ({existing.refresh}). A value set from here has no refresh
            strategy — to keep one, set it from code with <code>refresh</code>.
          </p>
        )}
        {error && (
          <p role="alert" data-type="error" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </FieldGroup>
      <SheetFooter className="border-t sm:flex-row sm:justify-end">
        <SheetClose disabled={pending} render={<Button type="button" variant="outline" />}>
          Cancel
        </SheetClose>
        <Button type="submit" disabled={pending || !name.trim() || !value || origins.length === 0}>
          {pending ? <Spinner data-icon="inline-start" /> : null}
          {existing ? "Update secret" : "Set secret"}
        </Button>
      </SheetFooter>
    </form>
  );
}
