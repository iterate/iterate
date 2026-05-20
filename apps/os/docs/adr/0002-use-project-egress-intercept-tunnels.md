# Use Project Egress Intercept Tunnels

OS no longer stores an external egress proxy URL on Projects. Instead, tests and operator debugging can open a Captun-backed Project Egress Intercept Tunnel through the Project-owned route `/__iterate/intercept-project-egress`, authenticated with the OS admin API secret, and the Project Durable Object keeps the active tunnel as ephemeral runtime state. This keeps outbound interception scoped to one Project Durable Object, removes persistent proxy configuration from the product model, avoids Semaphore/Cloudflare tunnel plumbing in e2e tests, and lets OS withhold Secret Material while still showing the original `getSecret(...)` incantation to the intercepting test.

Captun PR stack: https://github.com/iterate/captun/pull/1
