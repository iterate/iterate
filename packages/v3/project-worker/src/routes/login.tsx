// login.tsx — /login: the email form (the demo login verifies nothing — an email IS a user). `?next=`
// is where the sign-in goes after: the account page, or the /authorize URL the consent sent here;
// the server fn keeps it on this origin (worker.ts `sameOriginPath`). With a session already:
// "continue as <email>" / "switch account" (the consent's login hop lands here signed in).
// Google lands beside the email form later: one more button, one callback route, the same cookie.
//
// Every form in the console is a REAL form: `method="post"` to the console's machine door
// (control-plane.ts `consoleDoor`), its fields named as the door reads them. Submitted before the
// page's script has hydrated — a slow connection, a fast visitor, no script at all — the browser
// posts to the door and follows its 302; hydrated, `onSubmit` takes over and calls the server
// function: the same action, its refusal shown in the page instead of as a text response. Field
// values are read from the form at submit, never mirrored into state, so which came first —
// the typing or the hydration — does not matter.
import { useState, type FormEvent } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { signIn, signOut } from "../control-plane.ts";
import { consoleContext } from "./-console-context.ts";
import { issuerOf } from "./-session.ts";

/** Sign in as `email`: the user upserted, the cookie set on THIS response, where to go next (a path
 *  on this origin). The same door as the machine's `POST /login` (control-plane.ts). */
const login = createServerFn({ method: "POST" })
  .middleware([consoleContext])
  .inputValidator((data: { email: string; next: string }) => data)
  .handler(async ({ data, context }) => {
    const { setCookie, location } = await signIn(context.env, context.request, data);
    setResponseHeader("set-cookie", setCookie);
    return { location };
  });

/** Clear the session cookie — "switch account". */
const logout = createServerFn({ method: "POST" }).handler(() => {
  setResponseHeader("set-cookie", signOut());
  return null;
});

export const Route = createFileRoute("/login")({
  // `next` is optional and left as written: a default here would make the router normalize the URL
  // (`/login` → `/login?next=%2F`, a 307 on the server); the component defaults it.
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.next === "string" && search.next && { next: search.next }),
  }),
  beforeLoad: async () => ({ session: await issuerOf() }),
  loader: ({ context }) => context.session,
  component: LoginPage,
});

function LoginPage() {
  const { next = "/" } = Route.useSearch();
  const session = Route.useLoaderData();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get("email") ?? "");
    setPending(true);
    setError(null);
    try {
      const { location } = await login({ data: { email, next } });
      window.location.assign(location); // a full navigation: the page that follows SSRs with the cookie
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setPending(false);
    }
  };

  if (session)
    return (
      <main>
        <h1>Sign in</h1>
        <p>
          Signed in as <strong>{session.email}</strong>.{" "}
          <a href={next}>Continue as {session.email}</a>
        </p>
        {/* the door's `?next=`: back to this form, the same `next` — hydrated, the loader re-reads
            the cookie (gone) and the form below renders in place */}
        <form
          method="post"
          action={`/logout?next=${encodeURIComponent(`/login?next=${encodeURIComponent(next)}`)}`}
          onSubmit={async (event) => {
            event.preventDefault();
            await logout();
            await router.invalidate();
          }}
        >
          <button type="submit">Switch account</button>
        </form>
      </main>
    );

  return (
    <main>
      <h1>Sign in</h1>
      {next.startsWith("/authorize") && <p className="muted">to authorize an app</p>}
      <form method="post" action="/login" onSubmit={submit}>
        <input type="hidden" name="next" value={next} />
        <label>
          Email
          <input type="email" name="email" placeholder="you@example.com" required />
        </label>
        <button type="submit" disabled={pending}>
          Continue
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      <p className="muted">
        Enter an email and you become that user. (The demo login verifies nothing.)
      </p>
    </main>
  );
}
