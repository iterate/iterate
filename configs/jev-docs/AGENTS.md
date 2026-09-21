# Jev documentation experiment

Use the normal agent chat. Before the first answering request for new messages,
the platform awaits `worker.documentation.prepare`. This worker searches Iterate
docs, asks `typesafe/jev` to score up to 25 summaries in one Cloudflare AI call,
and fetches at most three selected docs. No extra answering-model turn is needed.

Edit `documentation.ts` to change the rubric, threshold or budget. The source
names, scores, model version, token use and latency are in `agent/context-prepared`
events. The request inspector reconstructs the exact included documentation.

Limits: keyword search supplies the candidates, so Jev cannot select a doc that
search missed. Selection uses message text, not attachments. The query is capped
at 8,000 characters and each selected doc at 6,000. Historical docs remain in
conversation history; the latest keyed context replaces the standing selection.
Selection has a 10-second budget. Failure is recorded and the agent proceeds with
its ordinary docs tools. New agents opt in during the existing birth configuration
window; if the project worker fails to configure an agent, it retains defaults.

The preparation callback must only read data. A timeout stops waiting but cannot
cancel an already dispatched Workers RPC call; its late response is discarded.

Model reference: https://developers.cloudflare.com/ai/models/typesafe/jev/
