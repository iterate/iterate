# Durable Objects Reading

It is important to read these before working on any Durable Object in this folder.

## First-party docs

- [What are Durable Objects?](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/) Explains the core Durable Objects model, including global identity, colocated durable storage, single-threaded execution, and the actor-style mental model.
- [Workers Binding API](https://developers.cloudflare.com/durable-objects/api/) Lists the core Durable Objects runtime surface area, including namespaces, IDs, stubs, state, storage, alarms, and related APIs.
- [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/) Captures the practical runtime rules and pitfalls that matter when writing correct Durable Object code.

## Boris Tane

- [What even are Cloudflare Durable Objects?](https://boristane.com/blog/what-are-cloudflare-durable-objects/) Gives a clear mental model for Durable Objects as stateful, globally addressable compute with strong consistency and in-memory state.
- [One Database Per User with Cloudflare Durable Objects and Drizzle ORM](https://boristane.com/blog/durable-objects-database-per-user/) Shows how Durable Objects can be used as per-user isolated SQLite databases and why that can simplify multi-tenant systems.
- [Unlimited On-Demand Graph Databases with Cloudflare Durable Objects](https://boristane.com/blog/durable-objects-graph-databases) Demonstrates a multi-tenant pattern where each Durable Object becomes an isolated graph database with its own storage and lifecycle.

## Kenton Varda

- [Workers Durable Objects Beta: A New Approach to Stateful Serverless](https://blog.cloudflare.com/introducing-workers-durable-objects/) Introduces Durable Objects from first principles and explains why they unlock strongly consistent stateful applications at the edge.
- [Durable Objects: Easy, Fast, Correct — Choose three](https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/) Explains the concurrency and storage model changes that make Durable Objects easier to reason about while improving correctness and performance.
- [Zero-latency SQLite storage in every Durable Object](https://blog.cloudflare.com/sqlite-in-durable-objects/) Explains why embedding SQLite directly inside Durable Objects changes the performance and ergonomics of stateful edge applications.

## Lambros Petrou

- [Durable Objects (DO) — Unlimited single-threaded servers spread across the world](https://www.lambrospetrou.com/articles/durable-objects-cloudflare/) Argues for a broader use of Durable Objects beyond real-time collaboration and frames them as a general-purpose boundary for stateful workloads.
- [Cloudflare Durable Objects are Virtual Objects](https://www.lambrospetrou.com/articles/durable-objects-are-virtual-objects/) Gives the right lifecycle mental model by stressing that Durable Objects are virtual actors you address and use, not resources you explicitly create and destroy.
