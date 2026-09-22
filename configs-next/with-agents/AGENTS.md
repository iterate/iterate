# Project configuration with agents

`worker.ts` serves the homepage and installs the agents app on `project/created`.
`agents.js` is a runnable bundle of `apps/agents/runtime`, copied into this project.
The app mounts `itx.agents` through a rewrite rule and owns its catalog and facets.
Edit this repository to customize it; upstream template changes do not replace it.
