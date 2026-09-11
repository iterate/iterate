import { useEffect, useState } from "react";

/** Keeps the append-to-server-state handoff pending; the browser tracks only its own submitted offset. */
export function useStreamSubmission(acknowledgedThroughOffset = Infinity) {
  const [pending, setPending] = useState(false);
  const [submittedOffset, setSubmittedOffset] = useState(0);
  const [error, setError] = useState<string>();
  const [overdueOffset, setOverdueOffset] = useState(0);
  const awaitingAcknowledgement = submittedOffset > acknowledgedThroughOffset;
  useEffect(() => {
    if (!awaitingAcknowledgement) {
      // Acknowledged sends are finished. Later feed delays cannot re-open them.
      if (submittedOffset) setSubmittedOffset(0);
      return;
    }
    // A saved input can outlive a halted processor. End the spinner with an
    // explicit explanation; never append the message again automatically.
    const timer = setTimeout(() => setOverdueOffset(submittedOffset), 30_000);
    return () => clearTimeout(timer);
  }, [awaitingAcknowledgement, submittedOffset]);

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
    isSubmitting: pending || (awaitingAcknowledgement && overdueOffset !== submittedOffset),
    error:
      error ??
      (awaitingAcknowledgement && overdueOffset === submittedOffset
        ? "Message saved, but the server has not confirmed processing. Check the agent status before sending again."
        : undefined),
  };
}
