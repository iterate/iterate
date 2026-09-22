// /projects/<slug>/secrets — the project's secrets as `itx.secrets.list()` shows them: each one's
// path, the origins it may be sent to, its refresh strategy's kind and when it was first set — never
// a value — with a delete per row, and the form that sets one: a name (the path `/secrets/<name>` an
// outbound request's `getSecret("/secrets/<name>")` placeholder spells), a value (a string, or a
// JSON object whose fields the placeholder's `{ field }` picks) and the origins the value may be
// sent to. The list is the route's loader; a set or a delete invalidates the router, which reloads it.
import { useState, type FormEvent } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@iterate-com/ui/components/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@iterate-com/ui/components/field";
import { Identifier } from "@iterate-com/ui/components/identifier";
import { Input } from "@iterate-com/ui/components/input";
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
  loader: async ({ context }) => ({
    secrets: await context.api.projects.get(context.project.id).secrets.list(),
  }),
  head: ({ params }) => ({ meta: [{ title: `Secrets · ${params.slug} · Dash` }] }),
  component: ProjectSecrets,
});

/** The name's grammar (os-next secrets.ts `assertSecretPath`): what `getSecret("/secrets/<name>")`
 *  can spell. The input's `pattern`, so the browser says so before the platform has to. */
const SECRET_NAME_PATTERN = "[a-zA-Z0-9._\\-]+";

function ProjectSecrets() {
  const { api, project } = Route.useRouteContext();
  const { secrets } = Route.useLoaderData();
  const router = useRouter();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [urls, setUrls] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const origins = urls.split(/[\s,]+/).filter(Boolean);

  const setSecret = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const path = `/secrets/${name.trim()}`;
    setError(null);
    setStatus(null);
    // the platform pins ORIGINS, so each entry must be a whole URL — said here, where it was typed
    const notAUrl = origins.find((origin) => !URL.canParse(origin));
    if (notAUrl) {
      setError(`"${notAUrl}" is not a URL — write the whole origin, like https://api.example.com`);
      return;
    }
    setSaving(true);
    try {
      await api.projects.get(project.id).secrets.set(path, value, { urls: origins });
      setStatus(`${path} is set. The value is stored encrypted and is not shown again.`);
      setName("");
      setValue("");
      setUrls("");
      await router.invalidate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const deleteSecret = async (path: string) => {
    setError(null);
    setStatus(null);
    setDeleting(path);
    try {
      await api.projects.get(project.id).secrets.delete(path);
      setStatus(`${path} is deleted.`);
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
        <h1 className="text-2xl font-semibold tracking-tight">Secrets</h1>
        <p className="text-sm text-muted-foreground">
          A secret is its path. In a worker or a script, put{" "}
          <code>getSecret("/secrets/&lt;name&gt;")</code> in an outbound request's URL or headers:
          the platform substitutes the value as the request leaves, and only towards the origins
          pinned here. A value never comes back out.
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
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
                <TableHead>Action</TableHead>
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
                    <AlertDialog>
                      <AlertDialogTrigger
                        render={<Button variant="outline" size="sm" />}
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
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Set a secret</CardTitle>
          <CardDescription>
            Setting a name that exists replaces its value. The value is stored encrypted and never
            shown again; the log records who set what and when, never the value.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={setSecret} className="flex flex-col gap-6">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="secret-name">Name</FieldLabel>
                <div className="flex items-center gap-1">
                  <span className="font-mono text-sm text-muted-foreground">/secrets/</span>
                  <Input
                    id="secret-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    pattern={SECRET_NAME_PATTERN}
                    title="Letters, digits, dots, underscores and dashes"
                    placeholder="stripe"
                    autoComplete="off"
                    spellCheck={false}
                    required
                    className="max-w-xs font-mono"
                  />
                </div>
                <FieldDescription>
                  Letters, digits, dots, underscores and dashes — the path is what the placeholder
                  spells.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="secret-value">Value</FieldLabel>
                <Textarea
                  id="secret-value"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  placeholder="sk_live_…"
                  autoComplete="off"
                  spellCheck={false}
                  required
                  rows={3}
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
                  className="font-mono"
                />
                <FieldDescription>
                  The origins the value may be sent to, separated by spaces or commas. A request to
                  any other host is refused, and the value is never sent there.
                </FieldDescription>
              </Field>
            </FieldGroup>
            <div>
              <Button
                type="submit"
                disabled={saving || !name.trim() || !value || origins.length === 0}
              >
                {saving ? "Setting…" : "Set secret"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
