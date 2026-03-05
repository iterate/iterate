Service abstraction

services/example

# Features

- Can deploy to cloudflare
- Can run in node
- Use Drizzle with D1 or better sqlite database
- Need to be able to use orpc in websockets mode

# Principles

- HTTP only - this means we can deploy in cloudflare and other HTTP-based edge networks

- We control the server and use vite in middleware mode
- Always follow the first party tutorials

- Eventually, a "service" might be a docker container that has multiple servers running

# Orpc

- We create a stack of
  - OpenAPI handler at /api

### Contracts

-

# Third party services

We want to support services that we didn't write

We should be able to run a teeny-tiny wrapper service really easily

So we make a service manifest

# Research

Grok research on hono vite middleware

- https://x.com/i/grok?conversation=2029627131563565231
- https://x.com/i/grok?conversation=2029649104708489549
