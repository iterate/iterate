# Repository layer

## Terminology

In the OS source, **Cloudflare Artifacts** is the hosted-Git repository product:
the repository is the source address and authority wrapper. Its build output is
a separately cacheable bundle keyed by pinned source and build configuration;
it is not an Artifact. This follows the owner correction in
[`apps/os/docs/itx-later.md`](../../../../apps/os/docs/itx-later.md#one-source-address--the-repo-is-the-artifact-wrapper).
Project-core's SQLite `Repositories` is a small immutable file-map implementation,
not that hosted-Git product, so this note calls its produced modules/build results
**build output** rather than artifacts.

`Repositories` turns only `repo.commit` events into immutable source revisions.
The root calls `await repos.prepare(event)` before it opens its append
transaction. Non-repository events return `undefined`. For a repository
event, preparation rejects malformed names, unsafe paths, oversized files, and
invalid data, hashes the canonical `{ files, parent, message }` revision, and
returns a callback. The root assigns the event offset, inserts the log event,
then calls that callback inside the same `transactionSync`.

The callback rereads the current head and accepts the commit only when its
`parent` is that head. A new repository accepts exactly one null-parent first
commit. Therefore a caller never supplies a revision, a stale client cannot
move a head, and a failed log transaction cannot leave a repo revision behind.

The tables split immutable file bytes (`repository_blobs`, keyed by SHA-256),
revision file maps, revision metadata, named commit membership, and mutable
heads. A revision can be read by its immutable hash only when it belongs to
the named repository. `modules({ repo, revision })` deliberately requires the
existing `main.js` module contract, while general repository snapshots may hold
other files.

## Root append integration

```ts
const mutation = await repos.prepare(input);
storage.transactionSync(() => {
  const offset = insertEvent(input); // normal idempotency handling happens first
  mutation?.(offset);
});
```

On an idempotent retry, the root must return the existing event before it calls
the mutation: replaying a valid event is not a second CAS transition.

## Deployed E2E scenarios

1. Append `repo.commit` with `{ name: "config", parent: null, files:
{"main.js": "export default {}"}, message: "initial" }`; read the head,
   snapshot and modules through the deployed public API. Assert the returned
   revision is 64 lowercase hex, the event offset is recorded, and `main.js`
   bytes round-trip.
2. Append a child with the returned revision as `parent`; assert head advances,
   the old immutable revision still reads unchanged, and source resolution uses
   the requested immutable revision rather than head.
3. Race two different children from one head. Exactly one append succeeds;
   the other reports `REPO_HEAD_CONFLICT`, leaves no revision/files, and cannot
   alter the head. Repeat the winning event id and assert normal event
   idempotency returns its original offset without another transition.
4. Attempt `../x`, `.git/config`, `constructor/x`, an invalid repo name, a
   claimed `revision` field, and a module source without `main.js`. Each fails
   before durable append; a later read/list shows no partial repository state.
