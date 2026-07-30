/**
 * Advances a PCM send deadline on its original absolute frame grid.
 *
 * A callback that is less than one frame late shortens the next wait so small
 * timer slips do not accumulate. Once the next grid point has already passed,
 * the schedule restarts one frame from now rather than emitting a catch-up
 * burst into the device.
 */
export function nextPcmFrameDeadline(
  currentDeadline: number,
  sentAt: number,
  frameDurationMs: number,
) {
  if (currentDeadline <= 0) {
    return sentAt + frameDurationMs;
  }
  const gridDeadline = currentDeadline + frameDurationMs;
  return gridDeadline <= sentAt ? sentAt + frameDurationMs : gridDeadline;
}
