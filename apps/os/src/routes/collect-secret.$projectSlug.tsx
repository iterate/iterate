import { Suspense, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2Icon, KeyRoundIcon } from "lucide-react";
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
import { ItxProvider, useItx } from "~/itx/itx-react.tsx";

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
});

function CollectSecretPage() {
  const { project } = Route.useRouteContext();
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Suspense fallback={<ItxResourceLoading label="project" />}>
        <ItxProvider projectId={project.id}>
          <CollectSecretCard />
        </ItxProvider>
      </Suspense>
    </main>
  );
}

function CollectSecretCard() {
  const search = Route.useSearch();
  const { projectSlug } = Route.useParams();
  const itx = useItx();
  const [material, setMaterial] = useState("");
  const [saved, setSaved] = useState(false);

  const submit = useMutation({
    mutationFn: async (value: string) => {
      const secret = itx.secrets.get(search.path);
      // Material and egress land in ONE update, so the secret is born already
      // pinned to its hosts — no window where it exists but cannot be used.
      await secret.update({ material: value, egress: { urls: search.egress } });
      // The secret processor folds the update asynchronously; don't announce
      // the secret before a request could actually use it.
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if ((await secret.__describe()).hasMaterial) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (search.notify !== undefined) {
        await itx.agents
          .get(search.notify)
          .message(
            `I submitted the secret at "${search.path}" via your collection link. ` +
              `It is stored write-only, pinned to ${search.egress.join(", ")}, and ready ` +
              `to use with getSecret placeholders.`,
          );
      }
    },
    onSuccess: () => setSaved(true),
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  if (search.egress.length === 0) {
    return (
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>This link is malformed</CardTitle>
          <CardDescription>
            It pins the secret to no egress hosts, so the value could never be used. Ask whoever
            sent it for a fresh link.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (saved) {
    return (
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CheckCircle2Icon className="mx-auto size-8 text-green-600" />
          <CardTitle>Secret saved</CardTitle>
          <CardDescription>
            {search.notify !== undefined
              ? "The agent that asked for it has been notified and will pick up from here. You can close this tab."
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
          {search.description ?? "An agent in this project needs a credential only you have."}
        </CardDescription>
      </CardHeader>
      <Separator />
      <CardContent className="space-y-4 pt-6">
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
