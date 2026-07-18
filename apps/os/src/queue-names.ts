const WORKER_EVENTS_QUEUE_SUFFIX = "-events";
const SEARCH_INDEX_QUEUE_SUFFIX = "-search-index-writes";
const SEARCH_INDEX_DEAD_LETTER_QUEUE_SUFFIX = "-search-index-write-failures";

export function workerEventsQueueName(workerName: string): string {
  return `${workerName}${WORKER_EVENTS_QUEUE_SUFFIX}`;
}

export function searchIndexQueueName(workerName: string): string {
  return `${workerName}${SEARCH_INDEX_QUEUE_SUFFIX}`;
}

export function searchIndexDeadLetterQueueName(workerName: string): string {
  return `${workerName}${SEARCH_INDEX_DEAD_LETTER_QUEUE_SUFFIX}`;
}
