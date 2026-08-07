Starter prompt, in a fresh project's chat:

> Fetch the full Sopranos episode list from TVMaze (https://api.tvmaze.com/singlesearch/shows?q=sopranos&embed=episodes) and tell me in one line what you got.

then, once it's answered:

> Which season has the highest average episode runtime, and what's the name of that season's last episode?

The embedded episodes payload is well past the inline result limit, and the follow-up needs the data again. Previously seen problems: paging the prior result with `itx.workspace.readFile` of the spill file instead of the preamble `results` array; defensively saving the response with `itx.workspace.writeFile` even though the platform retains results; returning the full raw payload when the next step needed a fraction of it; extra rounds re-fetching data it already had.

Success criteria: how it happens matters as much as the answer. The fetch script returns only what it needs (the platform retains the rest). Follow-up scripts reach prior data through the `results` array — `results[n].data` for small results, `await results[n].load(itx)` for large ones — with no `workspace.readFile` paging of prior results, no `writeFile` copies of API responses, no re-fetching, and minimal rounds. The agent digging into a fresh result on its own turn, before the follow-up, is fine if done through `results`. Small results render fully in history, so check it computes from `results[n].data` rather than retyping rendered values.
