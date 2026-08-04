export interface StackChanReferenceObservation {
  lifetimePlaybackContentSamples: number;
  referenceMeanAbsolute: number;
}

/*
 * The matched-path pilot is commanded at amplitude 64. StackChan's AEC does
 * not consume the digital source directly: it consumes the synchronous analog
 * feedback slot captured beside the microphone, where the retained physical
 * run measured roughly 55 mean counts. Half the commanded amplitude is above
 * the measured ambient reference mean (about six counts) while leaving ample
 * codec/room tolerance. This is a stimulus-validity threshold, not an AEC
 * quality threshold; suppression and double-talk retain their stricter,
 * independent waveform gates.
 */
const minimumQuietPilotReferenceMeanAbsolute = 32;
/*
 * A transient at a phase boundary previously satisfied the reference check
 * even when that phase's quiet pilot had not played. Requiring 500 ms of I2S-
 * consumed content makes the two observations independent and still fits well
 * inside each three-second settled assessment interval.
 */
const minimumPhasePlaybackContentSamples = 8_000;

export function stackChanMatchedReferenceObserved(
  observations: readonly StackChanReferenceObservation[],
): boolean {
  const first = observations[0];
  const last = observations.at(-1);
  if (!first || !last) return false;
  const contentProgress =
    last.lifetimePlaybackContentSamples - first.lifetimePlaybackContentSamples;
  return (
    contentProgress >= minimumPhasePlaybackContentSamples &&
    observations.some(
      (observation) => observation.referenceMeanAbsolute >= minimumQuietPilotReferenceMeanAbsolute,
    )
  );
}
