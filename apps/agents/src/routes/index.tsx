import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/")({
  component: () => (
    <main>
      <p className="eyebrow">AGENTS</p>
      <h1>Talk to your project's agents.</h1>
      <p>Every agent is a conversation on its own path; this page is a window onto it.</p>
      <a href="/.auth/login?next=/agents">Log in with Iterate</a>
    </main>
  ),
});
