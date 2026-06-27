Pending refactors:

- Projects should be ProjectCollection
- improve durable object name to maybe use iterate:// or https:// prefix or prj_123.iterate.app/some/path (never going to be publicly routable though). maybe streams.prj_123.iterate.app/some/path (needs a CNAME record per project though)

Snags

- maybe instead of "unknown" for runScript result or event payload/metadata we do want a serializable type so we don't depend on the wrangler types patch
- no docstrings flowing through from types.ts to server-side callers _Shit outta luck. TypeScript limitation of mapped types which alter the return type: https://github.com/microsoft/TypeScript/issues/50715_
- methods like "authenticate" in e2e tests in `using itx = session.authenticate` arn't clickable _fixed see patches/capnweb@0.8.0.patch - PR to follow_
- ProjectProcessorContract.buildEvent() helper or similar
- lint rule that automatically formats method declarations in RpcTarget and DurableObjects that implements nice interfaces from types.ts. Should be like this: async waitForEvent(args: Parameters<Stream["waitForEvent"]>[0]) {
  - though we have no learned that it's not necessarily a good idea for ProjectDurableObject to implement the Project interface, for example, because the create() method on the public API takes a `projectId?` and within a project durable object that makes no sense

- lint rule in reduce() method for stream processor implementations to no-isolated-functions so that no this methods and no imported methods can be called - pure function of arguments

# Rules

- do not declare inferrable types in implementation RpcTarget or DurableObject that implements a nice interface from types.ts
