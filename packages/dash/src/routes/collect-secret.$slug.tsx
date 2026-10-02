// /collect-secret/<slug> — the collection-link page; see `collectFromUser` in core/lib/src/api.ts.
// One card outside the Dash's shell, framed like the issuer's sign-in and consent pages.
// A visitor without a session signs in and returns here; one whose sign-in lacks the project
// is offered another. The requester's description is markdown the page renders without HTML or
// images, its links opening in a new tab with their host beside them.

// registers `itx.agents` on InstalledAppRoots
import type {} from "iterate/agents";
import {
  lazy,
  Suspense,
  useState,
  type ComponentProps,
  type ComponentType,
  type FormEvent,
} from "react";
import type { ExtraProps, StreamdownProps } from "streamdown";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import type { AuthenticatedApp } from "iterate/app";
import type { IterateContextApiWith } from "iterate/api";
import { Button } from "@iterate-com/ui/components/ui/button";
import { Field, FieldLabel } from "@iterate-com/ui/components/ui/field";
import { Input } from "@iterate-com/ui/components/ui/input";
import { IterateLogo } from "@iterate-com/ui/components/iterate-logo";
import { Spinner } from "@iterate-com/ui/components/ui/spinner";
import {
  ErrorMessage,
  StandaloneCard,
  StandalonePage,
} from "@iterate-com/ui/components/standalone-page";
import { Textarea } from "@iterate-com/ui/components/ui/textarea";
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
    fields: z.array(z.unknown()).optional().catch(undefined),
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
  // the parts of a secret of several, as `collectFromUser` checked them
  fields: z
    .array(
      z.object({
        name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
        label: z.string().trim().min(1).max(80),
        multiline: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(10)
    .optional(),
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
      <StandaloneCard>
        <header className="flex items-center gap-3">
          <IterateLogo alt="" className="size-8" />
          <h1 className="min-w-0 text-xl font-semibold tracking-tight wrap-anywhere">
            Save a secret for {project.slug}
          </h1>
        </header>
        {saved ? (
          <p role="status" className="text-sm">
            Saved. You can close this tab.
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
      </StandaloneCard>
    </StandalonePage>
  );
}

/** What the link asks for, then the value, or one value per field (`fields`): one `secrets.set`
 *  with the link's pin, and a message to the requesting agent, if the link names one. */
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
  // one Value, a pasted JSON object's fields becoming the secret's; or the link's own fields
  const inputs = link.fields || [{ name: "", label: "Value", multiline: true }];
  const [values, setValues] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const complete = inputs.every((input) => values[input.name]?.trim());

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
      const material = link.fields
        ? // a single-line field keeps what was typed, minus the spaces a paste carries at its ends
          Object.fromEntries(
            link.fields.map((field) => {
              const value = values[field.name] ?? "";
              return [field.name, field.multiline ? value : value.trim()];
            }),
          )
        : secretMaterialOf(values[""] ?? "");
      const project = api.projects.get(projectId);
      await project.secrets.set(link.path, material, { urls: link.urls });
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
          // the secret is saved either way; an agent waiting on it sees its `secret/set`
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
      {link.description ? <RequesterDescription markdown={link.description} /> : null}
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
        {link.agent ? (
          <>
            <dt className="text-muted-foreground">Asked by</dt>
            <dd className="font-mono wrap-anywhere">{link.agent}</dd>
          </>
        ) : null}
      </dl>
      {inputs.map((input, index) => {
        const id = `secret-${input.name || "value"}`;
        const props = {
          id,
          value: values[input.name] ?? "",
          onChange: (event: { target: { value: string } }) =>
            setValues((current) => ({ ...current, [input.name]: event.target.value })),
          // the first input takes the caret, so a paste lands without a click
          autoFocus: index === 0,
          autoComplete: "off",
          autoCapitalize: "off",
          autoCorrect: "off",
          spellCheck: false,
          required: true,
        };
        return (
          <Field key={id}>
            <FieldLabel htmlFor={id}>{input.label}</FieldLabel>
            {input.multiline ? (
              <Textarea {...props} rows={3} className="min-h-20 font-mono" />
            ) : (
              <Input {...props} className="h-11 font-mono" />
            )}
          </Field>
        );
      })}
      {error ? <ErrorMessage>{error}</ErrorMessage> : null}
      <Button type="submit" size="lg" className="h-11" disabled={pending || !complete}>
        {pending ? <Spinner data-icon="inline-start" /> : null}
        {existing ? "Update" : "Save"}
      </Button>
    </form>
  );
}

/** The requester's words, which an agent wrote: markdown rendered with no raw HTML and no images,
 *  only http(s) links, each opening in a new tab with its host beside it, so the person sees where
 *  a link goes before following it. The plain text shows while the renderer loads. */
function RequesterDescription({ markdown }: { markdown: string }) {
  return (
    <Suspense fallback={<p className="text-sm whitespace-pre-line wrap-anywhere">{markdown}</p>}>
      <RequesterMarkdown className="flex flex-col gap-2 text-sm wrap-anywhere [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-0 [&_ul]:list-disc [&_ul]:pl-5">
        {markdown}
      </RequesterMarkdown>
    </Suspense>
  );
}

const RequesterMarkdown: ComponentType<StreamdownProps> = lazy(async () => {
  const { Streamdown } = await import("streamdown");
  function Markdown(props: StreamdownProps) {
    return (
      <Streamdown
        mode="static"
        controls={false}
        linkSafety={{ enabled: false }}
        // no raw HTML: it is neither parsed (no rehype-raw) nor shown
        rehypePlugins={[]}
        skipHtml
        disallowedElements={["img"]}
        urlTransform={(url) => (/^https?:\/\//i.test(url) ? url : "")}
        components={{ a: RequesterLink }}
        {...props}
      />
    );
  }
  return { default: Markdown };
});

/** A link in the requester's words: a new tab, no referrer, its host beside it unless the words
 *  are the URL itself. One whose URL the page refused stays text. */
function RequesterLink({ href, children }: ComponentProps<"a"> & ExtraProps) {
  const host = href ? URL.parse(href)?.host : undefined;
  if (!href || !host) return <span>{children}</span>;
  const wordsAreTheUrl = typeof children === "string" && children.includes(host);
  return (
    <>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium underline underline-offset-2"
      >
        {children}
      </a>
      {wordsAreTheUrl ? null : <span className="text-muted-foreground"> ({host})</span>}
    </>
  );
}
