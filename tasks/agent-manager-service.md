---
state: next
priority: high
size: large
tags:
  - architecture
  - core
---

# Agent Manager Service Abstraction

Create a proper agent manager service abstraction. Two parts:

## Part 1: Agent Manager in Daemon

- tRPC router running in the daemon process
- Stores agent data in local SQLite
- Design with future worker migration in mind — don't change the interface later
- The coding agent harness used by an agent becomes a CRUD property

## Part 2: Agent Manager in Worker

- Move the service to the worker
- Agents can be on different machines
- Same interface as Part 1

When running locally, you get your own local agent manager. In production (hosted), it runs in a worker.
