export { resolveStreamPath } from "iterate/processors";

// The `${durableObjectName}#${processorSlug}` subscription-key convention
// builder died with the subscription-model redesign
// (docs/stream-subscription-model-redesign.md): names are opaque, and hosted
// processor subscriptions carry a required `processorSlug` plus placement in
// the receiver instead of encoding either into the name. Call sites author
// their `subscription-configured` payloads directly with a plain `name`.
