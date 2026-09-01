// The pure half of the composer's camera-roll strip (no Expo imports —
// vitest covers it in root CI): what a photo-library permission answer means
// for the strip.
//
// The rule that matters: the composer auto-expands on cold start and on
// foreground-after-a-while, so it must NEVER be the thing that raises an iOS
// photo-permission dialog. The strip therefore reads permission with the
// non-prompting getPermissionsAsync() and translates the answer here.
// "ask" is the only state that shows a tappable prompt; "unavailable" hides
// the strip completely, so a phone that said no once is never nagged (the +
// button still works — PHPicker needs no permission at all).

/** What the strip should render before it knows anything about the roll. */
export type PhotoLibraryAccess =
  /** Read the roll and show tiles. `limited` counts: iOS hands back the
   * subset the user chose, which is exactly what they wanted us to see. */
  | "granted"
  /** Show one "Allow" tile; the system dialog fires on tap. */
  | "ask"
  /** Render nothing at all: web has no photo library, and a denied phone
   * would only get a dialog iOS refuses to show. */
  | "unavailable";

export function photoLibraryAccessFrom(permission: {
  granted: boolean;
  canAskAgain: boolean;
}): PhotoLibraryAccess {
  if (permission.granted) return "granted";
  return permission.canAskAgain ? "ask" : "unavailable";
}
