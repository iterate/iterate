Snags

- no docstrings flowing through from types.ts to server-side callers
- methods like "authenticate" in e2e tests in `using itx = session.authenticate` arn't clickable
- lint rule that automatically formats method declarations in RpcTarget and DurableObjects that implements nice interfaces from types.ts. Should be like this: async waitForEvent(args: Parameters<Stream["waitForEvent"]>[0]) {

- lint rule in reduce() method for stream processor implementations to no-isolated-functions so that no this methods and no imported methods can be called - pure function of arguments

# Rules

- do not declare inferrable types in implementation RpcTarget or DurableObject that implements a nice interface from types.ts
