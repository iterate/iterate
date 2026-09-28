// /collect-secret/<slug> — the collection-link page; see `collectFromUser` in packages/iterate/src/api.ts.
// One card outside the Dash's shell, framed like the issuer's sign-in and consent pages.
// A visitor without a session signs in and returns here; one whose sign-in lacks the project
// is offered another.

// registers `itx.agents` on InstalledAppRoots
import type {} from "@iterate-com/agents";
import { useState, type FormEvent } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import type { AuthenticatedApp } from "iterate/app";
import type { IterateContextApiWith } from "iterate/api";
import { Button } from "@iterate-com/ui/components/button";
import { Card } from "@iterate-com/ui/components/card";
import { Field, FieldLabel } from "@iterate-com/ui/components/field";
import { IterateLogo } from "@iterate-com/ui/components/iterate-logo";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { ErrorMessage, StandalonePage } from "@iterate-com/ui/components/standalone-page";
import { Textarea } from "@iterate-com/ui/components/textarea";
import { iterateClient } from "../lib/iterate-client.ts";
import { SECRET_NAME, SECRETS_PREFIX, secretMaterialOf } from "../lib/secrets.ts";

export const Route = createFileRoute("/collect-secret/$slug")({
  // taken as they come, so a link a chat client mangled still opens and says so
  // (`CollectionLink` decides whether it can be used)
  validateSearch: z.object({
    project: z.string().optional().catch(undefined),
    platform: z.string().optional().catch(undefined),
    path: z.string().optional().catch(undefined),
    urls: z.array(z.string()).optional().catch(undefined),
    description: z.string().optional().catch(undefined),
    agent: z.string().optional().catch(undefined),
  }),
  // the session dials a WebSocket, which never runs on the server
  ssr: false,
  beforeLoad: async ({ location, params }) => {
    const session = await iterateClient.authenticate(location.href);
    const project = (await session.api.projects.list()).find(
      (candidate) => candidate.slug === params.slug,
    );
    if (!project) return session.signInFor(params.slug);
    return {
      api: session.api,
      info: session.info,
      project: { id: project.id, slug: project.slug },
    };
  },
  // whether the link's path holds a secret already: the button says Update then
  loader: async ({ context }) => ({
    secrets: await context.api.projects.get(context.project.id).secrets.list(),
  }),
  head: ({ params }) => ({ meta: [{ title: `Save a secret · ${params.slug} · Dash` }] }),
  component: CollectSecret,
});

/** A collection link's query as `collectFromUser` mints it. The origins are pinned as the platform
 *  pins them: http(s), no credentials, each URL reduced to its origin. */
const CollectionLink = z.object({
  project: z.string(),
  platform: z.string(),
  path: z
    .string()
    .refine(
      (path) =>
        path.startsWith(SECRETS_PREFIX) && SECRET_NAME.test(path.slice(SECRETS_PREFIX.length)),
    ),
  urls: z
    .array(
      z.url({ protocol: /^https?$/ }).refine((value) => {
        const url = new URL(value);
        return !url.username && !url.password;
      }),
    )
    .min(1)
    .transform((urls) => [...new Set(urls.map((value) => new URL(value).origin))]),
  description: z.string().optional(),
  agent: z.string().startsWith("/agents/").optional(),
});

function CollectSecret() {
  const { api, info, project } = Route.useRouteContext();
  const { secrets } = Route.useLoaderData();
  const [saved, setSaved] = useState(false);
  const parsedLink = CollectionLink.safeParse(Route.useSearch());
  // usable only on the project and the platform it was minted for
  const link =
    parsedLink.success &&
    parsedLink.data.project === project.id &&
    parsedLink.data.platform === info.platformOrigin
      ? parsedLink.data
      : null;
  return (
    <StandalonePage className="max-w-100">
      <Card className="gap-5 p-5 shadow-xs sm:p-6">
        <header className="flex items-center gap-3">
          <IterateLogo alt="" className="size-8" />
          <h1 className="min-w-0 text-xl font-semibold tracking-tight wrap-anywhere">
            Save a secret for {project.slug}
          </h1>
        </header>
        {saved ? (
          <p role="status" className="text-sm">
            Saved. You can close this tab and tell your agent you’re done.
          </p>
        ) : (
          <>
            {link ? (
              <CollectSecretForm
                api={api}
                projectId={project.id}
                link={link}
                existing={secrets.some((secret) => secret.path === link.path)}
                onSaved={() => setSaved(true)}
              />
            ) : (
              <ErrorMessage>
                {parsedLink.success
                  ? "This link is for a different project or iterate instance. Ask your agent for a new one."
                  : "This link is incomplete. Ask your agent for a new one."}
              </ErrorMessage>
            )}
            <p className="text-sm text-muted-foreground">
              Signed in as{" "}
              <strong className="font-medium text-foreground wrap-anywhere">
                {info.principal.email || info.principal.actor}
              </strong>
            </p>
          </>
        )}
      </Card>
    </StandalonePage>
  );
}

/** What the link asks for, then the value: one `secrets.set` with the link's pin, and a message to
 *  the requesting agent, if the link names one. */
function CollectSecretForm({
  api,
  projectId,
  link,
  existing,
  onSaved,
}: {
  api: AuthenticatedApp["api"];
  projectId: string;
  link: z.infer<typeof CollectionLink>;
  /** The path holds a secret already, which saving replaces, pin and all. */
  existing: boolean;
  onSaved: () => void;
}) {
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      // the socket reconnects on its own; a different instance by now must not get the value
      if ((await api.info()).platformOrigin !== link.platform) {
        setError("This link is for a different project or iterate instance.");
        return;
      }
      const project = api.projects.get(projectId);
      await project.secrets.set(link.path, secretMaterialOf(value), { urls: link.urls });
      if (link.agent) {
        // A link that names an agent: the agents app is installed, so the project's root has
        // `itx.agents` (the assertion iterate/api's `IterateContextApiWith` documents).
        const withAgents = project as typeof project &
          Pick<IterateContextApiWith<"agents">, "agents">;
        try {
          await withAgents.agents
            .get(link.agent)
            .message(`The user submitted the secret at ${link.path}. Its value was not included.`);
        } catch {
          // the saved line asks the person to tell their agent, which covers a message that failed
        }
      }
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={save} className="flex flex-col gap-5">
      {link.description ? (
        <figure className="flex flex-col gap-1.5 border-l-2 pl-3">
          <blockquote className="text-sm whitespace-pre-line italic wrap-anywhere">
            {link.description}
          </blockquote>
          {link.agent ? (
            <figcaption className="text-xs text-muted-foreground wrap-anywhere">
              — <span className="font-mono">{link.agent}</span>
            </figcaption>
          ) : null}
        </figure>
      ) : null}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">Path</dt>
        <dd className="font-mono wrap-anywhere">{link.path}</dd>
        <dt className="text-muted-foreground">Sent to</dt>
        <dd>
          <ul className="font-mono">
            {link.urls.map((url) => (
              <li key={url} className="wrap-anywhere">
                {url}
              </li>
            ))}
          </ul>
        </dd>
      </dl>
      <Field>
        <FieldLabel htmlFor="secret-value">Value</FieldLabel>
        <Textarea
          id="secret-value"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          required
          rows={3}
          className="min-h-20 font-mono"
        />
      </Field>
      {error ? <ErrorMessage>{error}</ErrorMessage> : null}
      <Button type="submit" size="lg" className="h-11" disabled={pending || !value}>
        {pending ? <Spinner data-icon="inline-start" /> : null}
        {existing ? "Update" : "Save"}
      </Button>
    </form>
  );
}
