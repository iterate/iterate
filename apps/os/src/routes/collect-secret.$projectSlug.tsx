import { Suspense, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import {
  CheckCircle2Icon,
  EyeIcon,
  EyeOffIcon,
  KeyRoundIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@iterate-com/ui/components/alert";
import { Button } from "@iterate-com/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@iterate-com/ui/components/card";
import { Field, FieldDescription, FieldLabel } from "@iterate-com/ui/components/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@iterate-com/ui/components/input-group";
import { toast } from "@iterate-com/ui/components/sonner";
import { ProjectScope, useItx, useItxQuery } from "iterate/sdk/itx/react";
import { requireOrganizationMemberForSession } from "../lib/auth.ts";
import { CollectSecretSearch } from "~/lib/collect-secret-link.ts";
import { getProjectBySlugServerFn } from "~/lib/project-server-fns.ts";
import { ItxResourceLoading } from "~/components/itx-boundary.tsx";

// The secret-collection deep link target: a chrome-free, one-job page an
// agent sends a user to when it needs a credential it must never see in
// chat (minted by itx.secrets.collectFromUser). Lives OUTSIDE the _app
// layout on purpose — no sidebar, no palette, just the form — but behind
// the same org-membership gate, so following the link signs the user in
// first and returns here.
//
// The phone does NOT open this page: the app renders the same request
// natively over the itx session it already holds
// (apps/mobile/src/app/project/[projectId]/collect-secret.tsx), so nobody on
// a phone signs in twice. This page serves everyone else — a link followed
// from a desktop, Slack, or email — and is still sized for a small screen,
// because that is often where it is read.
export const Route = createFileRoute("/collect-secret/$projectSlug")({
  validateSearch: CollectSecretSearch,
  // ProjectScope dials a WebSocket and throws during SSR — same shape as the
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
    <Card size="sm" className="w-full max-w-md">
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
    <main className="flex min-h-screen items-start justify-center p-4">
      {search.egress.length === 0 ? (
        // A pin to nothing can never be used — say so before dialing anything.
        <MalformedLinkCard />
      ) : (
        <Suspense fallback={<ItxResourceLoading label="secret" />}>
          <ProjectScope slug={project.slug}>
            <CollectSecretCard />
          </ProjectScope>
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
  const [revealed, setRevealed] = useState(false);
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
      // Material and egress land in one birth or update, so the secret is
      // pinned to its hosts — no window where it exists but cannot be used.
      const secretInput = { material: value, egress: { urls: search.egress } };
      if (existing.created === true) await secret.update(secretInput);
      else await secret.create(secretInput);
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
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  if (submit.data !== undefined) {
    return <SavedCard outcome={submit.data} />;
  }

  return (
    <Card size="sm" className="w-full max-w-md">
      <CardHeader className="grid-cols-[auto_1fr] items-center gap-x-3">
        <KeyRoundIcon className="row-span-2 size-5 text-muted-foreground" />
        <CardTitle>Provide a secret</CardTitle>
        <CardDescription>
          Someone in {projectSlug} asked for a credential only you have.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {search.description === undefined ? null : (
          <p className="text-sm text-muted-foreground">{search.description}</p>
        )}
        <dl className="space-y-1 text-xs">
          <div className="flex gap-2">
            <dt className="shrink-0 text-muted-foreground">Stored at</dt>
            <dd className="min-w-0 truncate">
              <code>{search.path}</code>
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="shrink-0 text-muted-foreground">Only ever sent to</dt>
            <dd className="min-w-0 break-all">
              {search.egress.map((url, index) => (
                <span key={url}>
                  {index === 0 ? null : ", "}
                  <code>{url}</code>
                </span>
              ))}
            </dd>
          </div>
        </dl>
        {existing.hasMaterial ? (
          <Alert variant="destructive" className="py-2">
            <TriangleAlertIcon className="size-4" />
            <AlertTitle className="text-sm">This replaces an existing secret</AlertTitle>
            <AlertDescription className="text-xs">
              Saving overwrites the value at {search.path} and its allowed hosts
              {existing.egress.urls.length > 0
                ? ` (currently ${existing.egress.urls.join(", ")})`
                : ""}
              .
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
            <InputGroup>
              <InputGroupInput
                id="secret-material"
                type={revealed ? "text" : "password"}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={material}
                onChange={(event) => setMaterial(event.currentTarget.value)}
              />
              <InputGroupAddon align="inline-end">
                {/* Pasting a credential on a phone is a blind action — the
                    submitter should be able to check they pasted the key and
                    not, say, their clipboard's previous occupant. */}
                <InputGroupButton
                  aria-label={revealed ? "Hide value" : "Show value"}
                  aria-pressed={revealed}
                  onClick={() => setRevealed(!revealed)}
                  size="icon-xs"
                >
                  {revealed ? <EyeOffIcon /> : <EyeIcon />}
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
            <FieldDescription className="text-xs">
              Stored write-only and encrypted — only ever substituted into requests to the hosts
              above, never readable by an agent, an API, or a person.
            </FieldDescription>
          </Field>
          <Button
            type="submit"
            className="mt-3 w-full"
            disabled={material.length === 0 || submit.isPending}
          >
            {submit.isPending ? "Saving..." : "Save secret"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function SavedCard({ outcome }: { outcome: SavedOutcome }) {
  const search = Route.useSearch();
  return (
    <Card size="sm" className="w-full max-w-md">
      <CardHeader className="text-center">
        <CheckCircle2Icon className="mx-auto size-6 text-green-600" />
        <CardTitle>Secret saved</CardTitle>
        <CardDescription>
          {outcome === "notified"
            ? "The agent that asked for it has been notified and will pick up from here. You can close this tab."
            : outcome === "notify-failed"
              ? `The secret is stored, but the agent that asked for it could not be notified. Tell it the secret at ${search.path} is ready.`
              : "You can close this tab."}
        </CardDescription>
      </CardHeader>
    </Card>
  );
}
