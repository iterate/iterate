const WORKER_EVENTS_QUEUE_SUFFIX = "-events";

export function workerEventsQueueName(workerName: string): string {
  return `${workerName}${WORKER_EVENTS_QUEUE_SUFFIX}`;
}
