# Stream shared-wake evidence

This branch stores the performance evidence referenced by draft PR #1902. It
is an evidence-only branch and is not intended to be merged.

## Archive

- File: `stream-shared-wake-evidence-2026-07-17.tar.gz`
- SHA-256: `27ea419b3cfe2dbd814981e859950aef0865cc3302a31f7546c93e830b8b400b`
- Size: 408 KiB
- Contents: methodology README, candidate patch, analyzer and output, fresh
  benchmark logs, historical benchmark logs, and benchmark server logs

The archive compares base commit `832baef84` with candidate commit
`f8a0dfb5d`. The equivalent latest-main correctness candidate was commit
`015ec527e` on local branch `stream-shared-wake-main-20260717-v2`; it passed
the 43 focused stream tests and the OS typecheck.

Before publication, the archive was scanned for authorization headers,
bearer tokens, common API-key and private-key formats, passwords, and JWTs.
No credential matches were found. URLs in the archive are localhost or
loopback benchmark endpoints.

Verify after downloading:

```sh
shasum -a 256 stream-shared-wake-evidence-2026-07-17.tar.gz
```
