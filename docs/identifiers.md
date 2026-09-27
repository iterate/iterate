# Identifiers

- slug: subdomain-safe
- id: stable identifier ([slugs and IDs](#slugs-and-ids))
- key: arbitrary string that uniquely identifies a value
- path: url-style path (with leading /)

name in _general_ is a user-facing string, a display name. Durable Objects are an exception and we should call them durableObjectName so we don't confuse ourselves. Our DO names will often be composed of an id, and some other identifiers. Or, often better, mint a prefixed id for the durable object name, and store it in an external record (e.g. a parent DO).

## Naming

Use explicit names.

Don't use all-caps acronyms in identifiers. So makeOrpcUrl instead of makeORPCURL (and `callbackUrl`, `userId`).

Make sure identifiers are greppable. For instance, try to re-use the exact term that is used elsewhere in the codebase. E.g. don't create a camel cased wrapper envVarName for ENV_VAR_NAME . Just use ENV_VAR_NAME everywhere, so it's easy to find all references.

Don't use fancy names - just use names that clearly describe what something is. For example a WebhookReceiver is good - it receives webhook HTTP requests and validates them.

## Slugs and IDs

- We use "slugs" as unique identifiers in many places, because they are url-safe
- Project slugs come from `projectSlug` in `apps/os/src/control-plane/catalog.ts`
- On a technical level, slugs CAN be changed! Esp project slugs.
- So for stable identifiers (e.g. for durable object names), always use IDs
- IDs are minted with a type prefix (`user_<hex>`, `org_<hex>`, `prj_<hex>`) by `newId` in `apps/os/src/control-plane/catalog.ts`. The deployment's own organization has the fixed id `org_admin` (`ADMIN_ORG_ID`).
