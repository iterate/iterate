# iterate/packages

The packages built on [iterate](https://iterate.com)'s platform ([iterate/core](https://github.com/iterate/core)) that anyone can install: the voice app, docs, GitHub sync and more, in `packages/`. Next to them are the apps iterate runs on the platform: the dash, agents, notes, docs, voice and admin apps, the static SPA and the Chrome extension (`packages/dash`, `packages/docs-app` and so on). The project templates that use the packages are in `configs/`. A self-hosted platform offers those templates by building with `--template "github:iterate/packages#main&path:configs/<name>"`; core's own templates, which need no packages, are in iterate/core's `core/configs`.

The rendered components in `packages/ui` are a [shadcn GitHub registry](https://ui.shadcn.com/docs/registry/github): in an app set up with `shadcn init` and a Base UI style such as `base-nova`, install a component as your app's own copy.

```sh
npx shadcn@latest add iterate/packages/context-view
```

`npx shadcn@latest list iterate/packages` lists the components.

Licenses: Apache-2.0 for every package with a LICENSE of its own (all but `packages/shared` and the apps), the `packages/ui` components included, and for the templates in `configs/`; AGPL-3.0 ([LICENSE](LICENSE)) for the rest.

This repo is a read-only copy of `packages/` and `configs/` from iterate's own repo, made by [Copybara](https://github.com/google/copybara) after each change to them. Paths are the same in both, and each commit ends in `GitOrigin-RevId: <sha>`, naming the commit it came from.

- Found a bug, or want something? [Open an issue](https://github.com/iterate/packages/issues).
- Have a fix in mind? Push it to a fork and link the compare view in an issue. Pull requests here would be overwritten by the next copy.

This README lives in iterate's repo at `copybara/packages/README.md`.
