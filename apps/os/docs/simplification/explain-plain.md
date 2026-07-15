## How you'd explain all this to a smart friend

An Iterate project is a named, fenced-off computer that remembers every lasting
fact, runs code in response, can rewrite that code, and can touch the world only
through one watched exit.

### Four things to know

> **What matters later gets written down before anyone acts.**

Each path has an ordered log. Messages, timers, decisions, requests, and results
go into it; live audio frames and other throwaway bytes do not.

> **State is what a reader has understood so far.**

A processor follows a log, updates its state, and remembers where it stopped.
Work that must survive a crash is written as requested, then completed, failed,
expired, or uncertain.

> **The repo is the part of the project that the project can rewrite.**

It holds the code and policy that decide how future facts are handled. Every
lasting result must name the exact code version that produced it, so replay
never means guessing which code used to run.

> **Tools plug in; bytes leave through one door.**

Slack, a browser, a GPU box, or a laptop is just a tool mounted at a path.
Inside one project, code may use what it has been given; it can never reach
another project, read secret material, or send external bytes except through
the watched exit.

An LLM fits without becoming a special kind of machine. Its request is written
down, its live chunks may flow past, and its final answer is written down.
Replay reads that answer; it never asks the model to invent it again.

### Why the code became heavy

> **Every new feature arrived as a new thing instead of another use of the old
> things.**

That was reasonable one feature at a time. Agents, schedulers, integrations,
files, sandboxes, and browsers all had real needs, so each gained its own
classes, routes, descriptions, and recovery code.

The weight came from solving the same jobs several times: several delivery
lanes, several processor hosts, several retry systems, several channel
transcribers, and several places for project files to live.

The public API then exposed those implementation parts as if users had to learn
them all. The idea stayed small, but its front door grew to 33 names and its
built-ins grew a second calling system beside streams.

### What to do

Just do this:

1. Make the front door teach four verbs: authenticate, append, follow, and
   fetch. Keep friendly helpers, but make them obvious shorthand.

2. Resolve built-ins and third-party tools as the same described mounts through
   one path walk. Generate code, docs, and discovery from one description.

3. Use one processor engine, hide the host, and write crash-safe work once:
   request, retry, expiry, and one terminal result.

4. Use one durable delivery rule everywhere, including the browser: the stream
   owns the cursor, successful delivery moves it, and failure retries or parks.
   Give high-rate live bytes a real pipe instead of fake log entries.

5. Let the first append create a path and record the exact code it activates.
   Reading a missing path must not create anything.

6. Make the repo the one home for project code and working views. A sandbox is
   a mounted computer, and building happens there rather than in a separate
   filesystem world.

7. Replace vendor-specific channel machines with one channel shape and keep
   routing, prompts, and reply policy in project code.

8. Keep three clear layers: a tiny hard floor, a few deep Iterate-run modules,
   and leaf packages. A third party must be able to rebuild the middle through
   public interfaces, but users should not have to assemble their company from
   twenty strangers’ packages.

### The wild ideas worth keeping

> **A durable call is a tiny workflow.**

Both use a request and a result; the quick form may leave no record, while the
crash-safe form keeps both and can resume.

> **Code plus history is a portable life.**

Export the repo, logs, referenced blobs, exact package versions, grants, and
effect receipts, and the project can move—even though its secrets, live
sessions, and outside consequences cannot.

> **Let new code relive yesterday before it gets today.**

Run a proposed change over real history with effects blocked, compare its state
and proposed actions, then use a small live trial before promotion.

> **Everything could be a package; not everything should be installed as one.**

Public interfaces should be strong enough to replace any non-core module, while
deep first-party modules may stay centrally run until a real replacement
exists.

> **A coding agent is a processor that can live anywhere.**

Give it ordered batches, a saved checkpoint, narrow temporary powers, and safe
retry keys; never promise that remote work happens exactly once.

> **Everything has a path; not everything is a file.**

Logs, repos, generated state, mounted tools, write-only secrets, and live pipes
can share one project tree without pretending they share one storage format.

> **Never rerun a guess when you can replay its answer.**

Model calls, human approvals, random choices, and outside responses become
facts once; every later replay reads those facts.

> **Don’t install a service; hire it.**

Two projects can exchange signed facts and narrow powers, letting a provider
update one living service instead of shipping code into a million repos.

Everything durable is an append. Everything alive is a follow. Everything that
can harm the outside world must cross the watched exit.
