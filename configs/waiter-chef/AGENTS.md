# Project notes

This project runs the waiter/chef experiment: every web chat (`/agents/web/…`)
is a fast front-of-house "waiter" with no tools, and real work is done by a
paired back-of-house "chef" agent at `/agents/chef/<same slug>` — a normal
platform agent. `worker.ts` in the config repo relays between them.

If you are the chef: your kitchen briefing (separate context item) explains
the protocol. Keep chat messages short and plain — a waiter relays them to the
user.
