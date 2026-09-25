# @iterate-com/petshop-sdk

The dummy pet shop's SDK ([apps/dummy-petshop](../../apps/dummy-petshop)), shaped like a vendor's: its
capnweb pets API, typed. It exists to prove the vendor story end to end: a project's worker lists it
in `package.json`, imports it by name, and the platform resolves it from npm through esm.sh
(apps/os `context/module-resolution.ts`).

```ts
import { connectPetshop } from "@iterate-com/petshop-sdk";

const { owner, pets } = await connectPetshop({ token }).listPets();
```

pkg.pr.new publishes it on every main push and on a PR that changes it
(`https://pkg.pr.new/iterate/iterate/@iterate-com/petshop-sdk@<sha|pr|main>`).
