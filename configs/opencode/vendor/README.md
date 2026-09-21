# vendor/opencode-workerd.js

`@opencode/sdk@2.0.12`'s `./workerd` entry, bundled into one file so the
platform's dynamic-worker bundler only has to compile this repo, not
install opencode's dependency tree (394 packages, 451MB) inside its 128MB
isolate.

Reproduce (from any scratch directory):

```sh
npm init -y && npm i @opencode/sdk@2.0.12 esbuild
printf 'export { OpenCodeWorkerd } from "@opencode/sdk/workerd"\n' > entry.ts
npx esbuild entry.ts --bundle --minify --format=esm --platform=node \
  --conditions=workerd '--external:cloudflare:*' --outfile=opencode-workerd.js
```

`opencode-workerd.d.ts` next to it is hand-written and covers only what
`apps/opencode/opencode.ts` uses.
