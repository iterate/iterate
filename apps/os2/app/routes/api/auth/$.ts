import { createFileRoute } from "@tanstack/react-router";
import { getAuth } from "../../../../backend/auth/auth.ts";
import { getDb } from "../../../../backend/db/client.ts";

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }) => handleAuthRequest(request),
      POST: ({ request }) => handleAuthRequest(request),
      PATCH: ({ request }) => handleAuthRequest(request),
      PUT: ({ request }) => handleAuthRequest(request),
      DELETE: ({ request }) => handleAuthRequest(request),
    },
  },
});

function handleAuthRequest(request: Request) {
  const db = getDb();
  const auth = getAuth(db);
  return auth.handler(request);
}
