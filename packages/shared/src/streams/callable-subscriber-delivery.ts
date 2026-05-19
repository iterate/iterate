export type CallableSubscriberDeliveryQueue = Record<string, number[]>;

export type CallableSubscriberDelivery = {
  offsets: number[];
  subscriberSlug: string;
};

export function selectCallableSubscriberDeliveries(args: {
  activeSubscriberSlugs: ReadonlySet<string>;
  queue: CallableSubscriberDeliveryQueue;
}): CallableSubscriberDelivery[] {
  const deliveries: CallableSubscriberDelivery[] = [];

  for (const [subscriberSlug, offsets] of Object.entries(args.queue)) {
    if (args.activeSubscriberSlugs.has(subscriberSlug)) continue;
    if (offsets.length === 0) continue;
    deliveries.push({ offsets: [...offsets], subscriberSlug });
  }

  return deliveries;
}

export function hasInactiveCallableSubscriberDeliveries(args: {
  activeSubscriberSlugs: ReadonlySet<string>;
  queue: CallableSubscriberDeliveryQueue;
}) {
  return selectCallableSubscriberDeliveries(args).length > 0;
}
