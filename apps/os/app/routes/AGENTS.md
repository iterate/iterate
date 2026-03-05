## Routes

Any file in here will be automatically picked up by tanstack router as a file based route.
For specific details, see https://tanstack.com/router/latest/docs/routing/file-based-routing

### Conventions

While tanstack router allows for flat route hierarchy, we use folders to group routes.
for example, `orgs/` contain all org related routes, `orgs.tsx` is the layout for the orgs and `orgs/index.tsx` is the index route for the orgs.

Almost all routes are under `_auth/` which makes sure a user is authenticated before accessing the routes.

Each route exports `Route = createFileRoute(...)`, see existing routes for examples.
If you get type errors while adding a new route, don't edit `routeTree.gen.ts`, run build and the route tree will be updated.

for params, search, navigation hooks use `Route.useParams`, `Route.useSearch`, `Route.useNavigate` instead of importing the hooks.
Only import the hooks, if the component is a generic one that is used in multiple places.

For everything else, follow examples and default tanstack router conventions.
