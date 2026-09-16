import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: () => (
    <main>
      <p className="eyebrow">VOICE</p>
      <h1>Talk to your project.</h1>
      <p>Press Call, speak, and the project's voice agent answers — from any browser.</p>
      <a href="/.auth/login?next=/call">Log in with Iterate</a>
    </main>
  ),
});
