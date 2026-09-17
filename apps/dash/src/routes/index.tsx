import { createFileRoute } from "@tanstack/react-router";
import { APPS } from "../apps.ts";
export const Route = createFileRoute("/")({
  component: () => (
    <main>
      <p className="eyebrow">DASH</p>
      <h1>Your sessions, projects and organizations.</h1>
      <p>Sign in, see everything your Iterate account reaches, and manage it from one place.</p>
      <a href="/.auth/login?next=/dashboard&scope=iterate%20account">Log in with Iterate</a>
      <h2>Apps</h2>
      <ul>
        {APPS.map((app) => (
          <li key={app.url}>
            <a href={app.url}>{app.name}</a> <span className="muted">{app.blurb}</span>
          </li>
        ))}
      </ul>
    </main>
  ),
});
