import { createFileRoute, redirect } from "@tanstack/react-router";
import { NULL_DURABLE_OBJECT_PROJECT_ID } from "~/lib/stream-navigation.ts";

export const Route = createFileRoute("/admin/")({
  beforeLoad: () => {
    throw redirect({
      to: "/admin/streams/$projectId",
      params: { projectId: NULL_DURABLE_OBJECT_PROJECT_ID },
    });
  },
});
