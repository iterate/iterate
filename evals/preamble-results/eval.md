https://os.iterate-preview-5.com/projects/nustom/agents/streams/agents/onboarding
https://os.iterate-preview-5.com/projects/nustom/agents/streams/agents/web/2026-08-06t16-13-19-265z
field testing of the script preamble (#2431). first stream went badly (pre-fix); second was better but still wasteful. preview streams are ephemeral, so the problems are described below and this eval stands alone: have an agent fetch a chunky dataset (some rows small enough to render inline, one result big enough to exceed the inline limit), then ask follow-ups that need that data.

problems as we saw them:

- paged a prior result with `JSON.parse(await itx.workspace.readFile(".../script-results/agent-output-424.json"))` instead of the preamble `results` array (`await results[0].load(itx)`) — the spill notice's fenced readFile recipe outcompeted the loader
- defensively saved an API response with `await itx.workspace.writeFile("sopranos-tvmaze-full.json", text)` even though the platform retains results
- returned the full raw payload when the next step needed a fraction of it
- spent extra rounds re-fetching data it already had

Success criteria: see that we've improved. Follow-up scripts reach prior data through the `results` array (`results[n].data` inline, `await results[n].load(itx)` for big ones); no workspace file copies of API responses, no re-fetching, fewer rounds. Two things we've watched confound naive checks: small results render fully inline, so the model can retype or mentally compute from the render (make the dataset big enough that this is hopeless), and the agent often digs into a fresh result on its own follow-up turn before the user asks — that's fine, and it counts as using the preamble if done through `results`.
