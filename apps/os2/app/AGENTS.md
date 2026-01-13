# Frontend Guidelines (apps/os2/app)

This folder contains the React frontend application.

## Dev Server

`pnpm dev` runs vite via Cloudflare tunnel. Key Doppler env vars:

- `CLOUDFLARE_TUNNEL_HOST` — tunnel hostname (e.g., `jonas.dev2.iterate.com`)
- `VITE_PUBLIC_URL` — must match tunnel URL for auth/callbacks to work
- `ITERATE_USER` — used in alchemy stage (`dev-$ITERATE_USER`) → determines `DAYTONA_SNAPSHOT_PREFIX`

Scripts use `sh -c` to expand `$ITERATE_USER` inside doppler context. Override with `STAGE=dev-foo pnpm dev`.

## Browser Testing

Skip signup: request OTP to any `+test@nustom.com` email, enter `424242` as OTP.

## React Patterns

### Avoid useEffect

Prefer alternatives:

- **Data fetching**: Use `useSuspenseQuery` with tRPC
- **Derived state**: Compute during render
- **Event responses**: Handle in event handlers
- **Reset state**: Use a key prop

useEffect IS appropriate for:

- External system synchronization (WebSockets, media queries, DOM APIs)
- Third-party library integration
- Subscriptions with cleanup

**Never use useEffect for data fetching.**

### Data Fetching with tRPC

Always use `useSuspenseQuery` with proper Suspense boundaries:

```tsx
const { data } = useSuspenseQuery(
  trpc.agent.conversation.getConversation.queryOptions({
    conversationId: "123",
  }),
);
```

Use `<Suspense>` and `<ErrorBoundary>` in sensible places.

### User Feedback

Use toast notifications, not inline message state:

```tsx
import { toast } from "sonner";

// Do this
toast.success("Saved!");
toast.error("Failed to save");

// Don't do this
const [error, setError] = useState<string | null>(null);
```

## Component Guidelines

See [/docs/design-system.md](/docs/design-system.md) for detailed component usage.

Key points:

- Use shadcn components, not raw HTML elements
- Use theme colors only - no random colors/gradients
- Use `Item` for lists/grids, `Card` for rich content
- Use `Field` components for forms
- Use `EmptyState` for empty states
- Use `Spinner` for loading states

## File Organization

- Components in `components/`
- UI primitives in `components/ui/`
- Hooks in `hooks/`
- Routes follow TanStack Router conventions in `routes/`
- Colocate tests as `*.test.ts` next to source files
