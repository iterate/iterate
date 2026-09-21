# First-message Jev documentation experiment

Use normal agent chat. This template lowers the platform's 60-second birth
debounce to one second. For the first incoming message only, it searches Iterate
API docs and examples, asks Cloudflare `typesafe/jev` to rank 12 summaries, and adds
up to three selected documents as ordinary developer context.

Success, failure or deadline restores the normal 250ms debounce. Later messages
do not run Jev. `jev-docs/started` and `jev-docs/settled` stream events record the
first message, outcome, selected sources, scores and timing. Durable markers
prevent repeat selection after worker restarts or event redelivery.
Existing agents that were not born with this template keep their normal behavior.

The one-second budget starts at the message timestamp and includes delivery,
search and fetch time. Late results are discarded. This is best effort: the
ordinary agent timer can answer without docs if selection or event delivery is
slow. Context append latency can still race that timer near the cutoff. A failed
project worker retains the platform's normal delivery/recovery behavior.

Edit `documentation.ts` to change the rubric and budgets. Keyword search supplies
the candidates; Jev cannot select a doc that search missed. Message attachments
are not classified. Docs selected for the first message remain in conversation
history. No platform changes or extra answering-model turn are required.

Model API: https://developers.cloudflare.com/ai/models/typesafe/jev/
