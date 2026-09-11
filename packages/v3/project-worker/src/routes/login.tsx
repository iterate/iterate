import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { browserAuthorization } from "../browser-client.ts";
import { appConfigOf } from "../app-config.ts";
import { sameOriginPath } from "../lib.ts";
import { consoleContext } from "./-console-context.ts";

const loginOptions = createServerFn({ method: "GET" })
  .middleware([consoleContext])
  .inputValidator((next: string) => next)
  .handler(async ({ data, context }) => {
    const config = appConfigOf(context.env);
    const session = await browserAuthorization(context.env, context.request, context.ctx);
    return {
      session: session && { email: session.principal.email },
      testEmailLogin: config.testEmailLogin,
      google: Boolean(config.googleClientId && config.googleClientSecret),
      next: sameOriginPath(data, config.platformOrigin),
    };
  });

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.next === "string" && search.next && { next: search.next }),
  }),
  loaderDeps: ({ search }) => ({ next: search.next || "/" }),
  loader: ({ deps }) => loginOptions({ data: deps.next }),
  component: LoginPage,
});

function LoginPage() {
  const { session, testEmailLogin, google, next } = Route.useLoaderData();
  return (
    <main>
      <h1>Sign in</h1>
      {session ? (
        <>
          <p>
            Signed in as <strong>{session.email}</strong>.
          </p>
          <p>
            <a href={next}>Continue as {session.email}</a>
          </p>
          <form
            method="post"
            action={`/.auth/logout?next=${encodeURIComponent(`/login?next=${encodeURIComponent(next)}`)}`}
          >
            <button type="submit">Switch account</button>
          </form>
        </>
      ) : (
        <>
          {testEmailLogin && (
            <form method="post" action="/login">
              <input type="hidden" name="next" value={next} />
              <label>
                Email
                <input type="email" name="email" placeholder="you@example.com" required />
              </label>
              <button type="submit">Continue</button>
              <p className="muted">Test sign-in: use any email. No verification.</p>
            </form>
          )}
          {google && (
            <p>
              <a href={`/.auth/identity?next=${encodeURIComponent(next)}`}>Continue with Google</a>
            </p>
          )}
          {!testEmailLogin && !google && <p>Sign-in is not configured for this deployment.</p>}
        </>
      )}
    </main>
  );
}
