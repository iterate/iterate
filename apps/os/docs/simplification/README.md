# Simplification: the document pile

An overnight, append-only exploration of how to collapse `apps/os` onto a few
simple concepts. Deliberately many voices, contradicting each other. Not a
plan — a body of thinking to interview Jonas from and cook down.

## How to read this

Start with the **notebook** (the curated running analysis):
- [`../simplification-ruminations-2026-07.md`](../simplification-ruminations-2026-07.md)
  — vision, verified collapse proposals (§5), the big ideas examined (§6),
  crazy corner (§7), codex dialogue (§8), and appendices with the full
  subagent/codex outputs.

Then the pile (this folder). **If you read three things: `synthesis.md`, then
`open-questions-and-interview.md` (the morning agenda), then whichever
`explain-*.md` framing fits your mood.**

| File | What it is |
|---|---|
| `synthesis.md` | **The cook-down.** The one-thing-everyone-agreed-on, the three true answers, the five concepts, what to actually do (three tiers), the disagreements worth keeping. Read this first. |
| `open-questions-and-interview.md` | **The morning agenda.** The real forks where the analysis needs *your* call: fast wins, big framing forks, mechanism forks, where reviewers disagree, wild-idea keep/kill. |
| `explain-entity-runtime.md` | Consolidated explanation #1 — "a durable outer event loop wrapped around ordinary code." The vision framing. 5k-core + API + diff-from-today + attacks the other two. |
| `explain-operating-system.md` | Consolidated explanation #2 — "an OS: kernel / std-lib / packages, three rings, two shells." The governance framing. |
| `explain-one-log.md` | Consolidated explanation #3 — "one log and a fold; a database turned inside out." The engineering framing. |
| `explain-referee.md` | Codex's scored referee report across the three framings: winner-by-audience, the convergence, the wall paragraph. |
| `explain-plain.md` | The Feynman/Karpathy closing — the whole thing in plain words and slogans ("nothing is faster than light, not even gravity"). |
| `devils-advocate.md` | The boring-tech skeptic: why this whole edifice might be a mistake (and the 2-3 ideas that survive even that). |
| `lens-content-addressed.md` | Unison/Nix lens — the concrete answer to the 1M-repo update problem (you already have ~60% of it built). |
| `lens-sovereign-computer.md` | Urbit lens — the closest existing relative, and the idiolect warning that outranks the architecture. |
| `crazy-vfs-and-entity-runtime.md` | Codex on "the project is one filesystem" — verdict: everything has a *path*, not everything is a *file*. |
| `debate-log.md` | **Append-only stream of consciousness.** Every voice distilled, unsorted. The compost heap. |

## The through-line so far (subject to demolition)

> History is the only substance. There is one write (append) and one read
> (follow). A processor is a follower that never stops. The kernel moves
> events and guards two doors; everything else is a package. An iterate
> project is an intelligent entity that is exactly `(repo, journal)`.

Every lens and essay in this folder is trying either to sharpen that or to
prove it's a beautiful trap.
