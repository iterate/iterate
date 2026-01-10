import { useReducer, useEffect, useRef, useState } from "react";

export interface StreamState<T> {
  data: T;
  isLoaded: boolean;
}

export function useStreamReducer<T, E>(
  streamUrl: string | null,
  reducer: (state: T, event: E) => T,
  initialState: T,
): StreamState<T> {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [isLoaded, setIsLoaded] = useState(false);
  const offsetRef = useRef("-1");

  useEffect(() => {
    if (!streamUrl) return;

    setIsLoaded(false);
    const url = new URL(streamUrl);
    url.searchParams.set("offset", offsetRef.current);
    url.searchParams.set("live", "sse");

    const es = new EventSource(url.toString());

    es.addEventListener("control", (evt) => {
      try {
        const ctrl = JSON.parse(evt.data);
        if (ctrl.streamNextOffset) offsetRef.current = ctrl.streamNextOffset;
        if (ctrl.upToDate) setIsLoaded(true);
      } catch {
        // ignore parse errors
      }
    });

    es.addEventListener("data", (evt) => {
      try {
        const data = JSON.parse(evt.data);
        if (Array.isArray(data)) {
          for (const item of data) {
            dispatch(item);
          }
        } else {
          dispatch(data);
        }
      } catch {
        // ignore parse errors
      }
    });

    return () => es.close();
  }, [streamUrl]);

  return { data: state, isLoaded };
}

export interface AgentInfo {
  path: string;
  contentType: string;
  createdAt: string;
}

export interface RegistryEvent {
  type: string;
  key: string;
  value?: AgentInfo;
  headers?: { operation: string };
}

export function registryReducer(state: AgentInfo[], event: RegistryEvent): AgentInfo[] {
  if (event.headers?.operation === "insert" && event.value) {
    return state.some((a) => a.path === event.value!.path) ? state : [...state, event.value];
  }
  if (event.headers?.operation === "delete") {
    return state.filter((a) => a.path !== event.key);
  }
  return state;
}

export const API_URL = typeof window !== "undefined" ? `${window.location.origin}/api` : "/api";
