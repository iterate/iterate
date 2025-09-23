---
slug: how-we-use-linear
match: hasMCPConnection("https://api.githubcopilot.com/mcp/")
---

# How We Use Github

- Results limit: All PR queries return only the top 5 most recent PRs (sorted by creation date, newest first). Never show more than 10 PRs at a time.
- Our monorepo is "os", and our own estate repo is: "iterate"
- Links & style: Link PRs as <{pr.html_url}|#{pr.number}>. Use bullets, include key counts and simple latency metrics; keep it brief.
