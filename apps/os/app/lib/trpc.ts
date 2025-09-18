import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "../../backend/trpc/root.ts";

// This works - using explicit type annotation to fix TS2742 error
export const trpc: ReturnType<typeof createTRPCReact<AppRouter>> = createTRPCReact<AppRouter>();
