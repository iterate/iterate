import { useState } from "react";

/** Keeps the append-to-server-state handoff pending; the browser tracks only its own submitted offset. */
export function useStreamSubmission(acknowledgedThroughOffset = Infinity) {
  const [pending, setPending] = useState(false);
  const [submittedOffset, setSubmittedOffset] = useState(0);
  const [error, setError] = useState<string>();

  async function runSubmit(action: () => Promise<number | void>): Promise<boolean> {
    setPending(true);
    setError(undefined);
    try {
      const offset = await action();
      if (offset !== undefined) setSubmittedOffset(offset);
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      return false;
    } finally {
      setPending(false);
    }
  }

  return {
    runSubmit,
    isSubmitting: pending || submittedOffset > acknowledgedThroughOffset,
    error,
  };
}
