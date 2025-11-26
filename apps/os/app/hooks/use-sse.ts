import { fetchEventSource, type FetchEventSourceInit } from "@microsoft/fetch-event-source";
import { useEffect } from "react";

export type UseSSEOptions = FetchEventSourceInit;
export function useSSE(input: RequestInfo, options: UseSSEOptions) {
  useEffect(() => {
    const controller = new AbortController();

    fetchEventSource(input, {
      signal: controller.signal,
      ...options,
    });

    return () => {
      controller.abort();
    };
  }, [input, options]);
}
