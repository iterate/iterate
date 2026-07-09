// What a worker serves after erase-data destroyed its Durable Objects:
// parked until the next deploy. Deliberately a 503 — the preview machinery
// treats "parked" as a healthy slot. The queue handler must exist because
// queue-consumer registration lives on the queue, not the script: Cloudflare
// rejects any new version of a consuming worker without one (error 11001,
// observed live on preview-4). It acks-and-drops — an erased environment has
// nothing left to process.
export default {
  fetch: () =>
    new Response("This environment's data was erased; the next deploy brings it back.", {
      status: 503,
      headers: { "content-type": "text/plain" },
    }),
  queue: (batch) => batch.ackAll(),
};
