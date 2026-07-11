import { Suspense, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2Icon, KeyRoundIcon, TriangleAlertIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@iterate-com/ui/components/alert";
import { Button } from "@iterate-com/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@iterate-com/ui/components/card";
import { Field, FieldDescription, FieldLabel } from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import { Separator } from "@iterate-com/ui/components/separator";
import { toast } from "@iterate-com/ui/components/sonner";
import { requireOrganizationMemberForSession } from "../lib/auth.ts";
import { CollectSecretSearch } from "~/lib/collect-secret-link.ts";
import { getProjectBySlugServerFn } from "~/lib/project-server-fns.ts";
import { ItxResourceLoading } from "~/components/itx-boundary.tsx";
import { ItxProvider, useItx, useItxQuery } from "~/itx/itx-react.tsx";

// The secret-collection deep link target: a chrome-free, one-job page an
// agent sends a user to when it needs a credential it must never see in
// chat (minted by itx.secrets.collectFromUser). Lives OUTSIDE the _app
// layout on purpose — no sidebar, no palette, just the form — but behind
// the same org-membership gate, so following the link signs the user in
// first and returns here.
export const Route = createFileRoute("/collect-secret/$projectSlug")({
  validateSearch: CollectSecretSearch,
  // ItxProvider dials a WebSocket and throws during SSR — same shape as the
  // project layout (_app/projects/$projectSlug/route.tsx).
  ssr: false,
  beforeLoad: async ({ context, location, params }) => {
    requireOrganizationMemberForSession(
      context.authSession,
      location,
      context.iterateAuthIssuer,
      context.authError,
      context.appOrigin,
    );
    return { project: await getProjectBySlugServerFn({ data: { slug: params.projectSlug } }) };
  },
  component: CollectSecretPage,
  // A truncated/rewritten link (chat clients mangle long URLs) fails
  // validateSearch — this page's audience is a person holding a link, so
  // they get the malformed-link card, not the dev-flavored root error.
  errorComponent: () => (
    <main className="flex min-h-screen items-center justify-center p-4">
      <MalformedLinkCard />
    </main>
  ),
});

function MalformedLinkCard() {
  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>This link is malformed</CardTitle>
        <CardDescription>
          It does not describe a usable secret. Ask whoever sent it for a fresh link.
        </CardDescription>
      </CardHeader>
    </Card>
  );
}

function CollectSecretPage() {
  const { project } = Route.useRouteContext();
  const search = Route.useSearch();
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      {search.egress.length === 0 ? (
        // A pin to nothing can never be used — say so before dialing anything.
        <MalformedLinkCard />
      ) : (
        <Suspense fallback={<ItxResourceLoading label="secret" />}>
          <ItxProvider projectId={project.id}>
            <CollectSecretCard />
          </ItxProvider>
        </Suspense>
      )}
    </main>
  );
}

/** How the submit ended: stored + agent told, stored but the notify failed
 * (the one partial state — the user must relay by hand), or stored with no
 * agent to tell. The secret itself is never half-stored: material + egress
 * land in one update. */
type SavedOutcome = "notified" | "notify-failed" | "no-notify";

function CollectSecretCard() {
  const search = Route.useSearch();
  const { projectSlug } = Route.useParams();
  const itx = useItx();
  const [material, setMaterial] = useState("");
  const [saved, setSaved] = useState<SavedOutcome | null>(null);
  // An unsigned link can point at an EXISTING secret — an org member pasting
  // a value here would silently replace its material and repin its egress.
  // Describe the path up front and say so before they type anything.
  const existing = useItxQuery({
    key: ["collect-secret", projectSlug, search.path],
    query: (itx) => itx.secrets.get(search.path).__describe(),
  });

  const submit = useMutation({
    mutationFn: async (value: string): Promise<SavedOutcome> => {
      const secret = itx.secrets.get(search.path);
      // Material and egress land in ONE update, so the secret is born already
      // pinned to its hosts — no window where it exists but cannot be used.
      await secret.update({ material: value, egress: { urls: search.egress } });
      // describe() is read-your-writes (the secret DO catches up its own fold
      // before snapshotting), so one assertion — no wait — is the honest
      // "stored and usable" check before anything is announced.
      if ((await secret.__describe()).hasMaterial !== true) {
        throw new Error(`The secret at ${search.path} did not report stored material.`);
      }
      if (search.notify === undefined) return "no-notify";
      // The secret IS stored from here on — a notify failure must not present
      // as total failure (the user would retype; the agent would wait forever).
      try {
        await itx.agents
          .get(search.notify)
          .message(
            `I submitted the secret at "${search.path}" via your collection link. ` +
              `It is stored write-only, pinned to ${search.egress.join(", ")}, and ready ` +
              `to use with getSecret placeholders.`,
          );
        return "notified";
      } catch (error) {
        // The secret is stored either way; surface the notify failure to the
        // user as copy (below) and keep the cause diagnosable.
        console.error(`collect-secret: failed to notify ${search.notify}`, error);
        return "notify-failed";
      }
    },
    onSuccess: (outcome) => setSaved(outcome),
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  if (saved !== null) {
    return (
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CheckCircle2Icon className="mx-auto size-8 text-green-600" />
          <CardTitle>Secret saved</CardTitle>
          <CardDescription>
            {saved === "notified"
              ? "The agent that asked for it has been notified and will pick up from here. You can close this tab."
              : saved === "notify-failed"
                ? `The secret is stored, but the agent that asked for it could not be notified. Tell it the secret at ${search.path} is ready.`
                : "You can close this tab."}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="text-center">
        <KeyRoundIcon className="mx-auto size-6 text-muted-foreground" />
        <CardTitle className="text-xl">Provide a secret</CardTitle>
        <CardDescription>
          Someone in this project asked for a credential only you have.
        </CardDescription>
      </CardHeader>
      <Separator />
      <CardContent className="space-y-4 pt-6">
        {search.description === undefined ? null : (
          <div className="space-y-1 text-sm">
            <div className="text-muted-foreground">The requester says</div>
            <div>{search.description}</div>
          </div>
        )}
        <div className="space-y-1 text-sm">
          <div className="text-muted-foreground">Stored at</div>
          <code className="text-xs">{search.path}</code>
        </div>
        <div className="space-y-1 text-sm">
          <div className="text-muted-foreground">Can only ever be sent to</div>
          <ul className="space-y-0.5">
            {search.egress.map((url) => (
              <li key={url}>
                <code className="text-xs">{url}</code>
              </li>
            ))}
          </ul>
        </div>
        {existing.hasMaterial ? (
          <Alert variant="destructive">
            <TriangleAlertIcon className="size-4" />
            <AlertTitle>This replaces an existing secret</AlertTitle>
            <AlertDescription>
              {`A secret already exists at ${search.path}`}
              {existing.egress.urls.length > 0
                ? `, currently pinned to ${existing.egress.urls.join(", ")}`
                : ""}
              . Saving overwrites its value and its allowed hosts.
            </AlertDescription>
          </Alert>
        ) : null}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (material.length > 0) submit.mutate(material);
          }}
        >
          <Field>
            <FieldLabel htmlFor="secret-material">Value</FieldLabel>
            <Input
              id="secret-material"
              type="password"
              autoComplete="off"
              value={material}
              onChange={(event) => setMaterial(event.currentTarget.value)}
            />
            <FieldDescription>
              Stored write-only and encrypted — no agent, API, or person can ever read it back; it
              is only substituted into requests to the hosts above.
            </FieldDescription>
          </Field>
          <Button
            type="submit"
            className="mt-4 w-full"
            disabled={material.length === 0 || submit.isPending}
          >
            {submit.isPending ? "Saving..." : "Save secret"}
          </Button>
        </form>
      </CardContent>
      <CardFooter className="justify-center text-xs text-muted-foreground">
        Project: {projectSlug}
      </CardFooter>
    </Card>
  );
}
