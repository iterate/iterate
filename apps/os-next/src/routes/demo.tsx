import { createFileRoute } from "@tanstack/react-router";
import { Demo } from "../client/demo.tsx";

/** THE HOSTED DEMO (client/demo.tsx): client-only, it dials /api with the visitor's login cookie. */
export const Route = createFileRoute("/demo")({ ssr: false, component: Demo });
