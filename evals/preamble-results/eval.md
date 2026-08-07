Starter prompt, in a fresh project's chat:

> Fetch the full Sopranos episode list from TVMaze (https://api.tvmaze.com/singlesearch/shows?q=sopranos&embed=episodes) and tell me in one line what you got.

then, once it's answered:

> Which episodes was Carmela happy in?

The embedded episodes payload is well past the inline result limit, and the follow-up needs the data again — this time for semantic judgment over the episode summaries, so there's no arithmetic shortcut: the agent has to pull the prior data through `results` and reason over the summaries (in its own head, or via a filter script that narrows to Carmela-relevant episodes first). Previously seen problems: paging the prior result with `itx.workspace.readFile` of the spill file instead of the preamble `results` array; defensively saving the response with `itx.workspace.writeFile` even though the platform retains results; returning the full raw payload when the next step needed a fraction of it; extra rounds re-fetching data it already had.

Success criteria: how it happens matters as much as the answer. The fetch script returns only what it needs (the platform retains the rest). Follow-up scripts reach prior data through the `results` array — `results[n].data` for small results, `await results[n].load(itx)` for large ones — with no `workspace.readFile` paging of prior results, no `writeFile` copies of API responses, no re-fetching, and minimal rounds. The Carmela answer should come from the retained summaries (e.g. a script that loads the prior result and returns the episodes mentioning her, then judgment over those), not from another fetch. The agent digging into a fresh result on its own turn, before the follow-up, is fine if done through `results`.
