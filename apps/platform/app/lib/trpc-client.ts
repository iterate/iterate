import { createTRPCClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from '../../backend/trpc/root.ts';

export const trpcClient = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: '/api/trpc',
      // Include credentials to send cookies
      fetch(url, options) {
        return fetch(url, {
          ...options,
          credentials: 'include',
        } as RequestInit);
      },
    }),
  ],
});
