---
state: todo
priority: high
size: s
dependsOn: []
---

Add iptables loop guards for egress direct mode when targets use `:80` or `:443` so direct outbound requests cannot be re-captured by Caddy.
