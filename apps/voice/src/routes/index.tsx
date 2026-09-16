import { createFileRoute, redirect } from "@tanstack/react-router";

/** The app is its one page: signed in lands on the phone, signed out is sent to sign in by it. */
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/call" });
  },
});
