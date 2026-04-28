---
state: planned
priority: medium
size: medium
dependsOn: []
---

# Advanced fetch path rewrites

V1 only supports `fetchRequest.path.mode: "prefix" | "replace"` with an
optional `fetchRequest.path.base`. Add richer request rewrite behavior only
once callers need it.

The current public URL via field is just `url`. Avoid reintroducing
terms like `origin` or `mount URL` unless a later design needs more precise
terminology than a URL via value plus `fetchRequest.path`.

Prior art to consider:

- Caddy `reverse_proxy`, `rewrite`, `uri strip_prefix`, and `handle_path`:
  https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
- Envoy `prefix_rewrite`:
  https://www.envoyproxy.io/docs/envoy/latest/api-v3/config/route/v3/route_components.proto.html
- NGINX `proxy_pass` URI replacement behavior:
  https://nginx.org/en/docs/http/ngx_http_proxy_module.html

Planned questions:

- route-match-aware strip prefix
- replace prefix
- query modes: preserve, replace, merge
- header rewrite operations
