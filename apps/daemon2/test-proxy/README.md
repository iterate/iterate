# Test Proxy Setup

Tests that the app works correctly when mounted at a subpath by a reverse proxy.

## How it works

1. The app outputs `<base href="/">` and uses relative asset paths (`./assets/...`)
2. nginx proxies requests from `/machines/test-123/` to the app at `/`
3. nginx rewrites `<base href="/"` → `<base href="/machines/test-123/"`
4. All relative URLs now resolve correctly against the subpath

## Usage

```bash
# Terminal 1: Build and run the app
cd apps/daemon2
pnpm build
pnpm start  # Runs on port 3000

# Terminal 2: Run the nginx proxy
cd apps/daemon2/test-proxy
docker compose up

# Open browser
open http://localhost:8080/machines/test-123/
```

## What to test

1. **Initial page load** - Page should render correctly
2. **Assets loading** - Check Network tab, CSS/JS should load from `/machines/test-123/assets/...`
3. **Client-side navigation** - Click around, URLs should stay under `/machines/test-123/`
4. **Deep link refresh** - Navigate to a subpage, refresh the browser - should still work
5. **API calls** - Check that trpc/API calls go to `/machines/test-123/api/...`
