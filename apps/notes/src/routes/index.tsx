import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/")({
  component: () => (
    <main>
      <p className="eyebrow">NOTES</p>
      <h1>A page for each project.</h1>
      <p>Write a note and keep it with your Iterate project.</p>
      <a href="/.auth/login?next=/notes">Log in with Iterate</a>
    </main>
  ),
});
