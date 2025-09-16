import { createTRPCReact } from '@trpc/react-query';
import type { AppRouter } from '../../backend/trpc/root.ts';

export const trpc = createTRPCReact<AppRouter>();
