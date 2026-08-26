// The camera-roll strip that sits directly above the note composer's text
// field: one row, sideways scrollable, newest first. Tap a tile to attach
// that photo to the note you're writing; tap it again to take it back off.
//
// It exists because the photo you want is almost always the one you just
// took, and reaching it used to cost a + tap, a modal, and a picker dismiss.
// The + button is untouched — it is still the way to reach anything older
// than the strip, and the only way in when photo permission is refused.
//
// Reading an asset's bytes can involve an iCloud download, so a tapped tile
// spins until it resolves; the attachment only joins the note once it has
// real bytes (lib/recent-photos.ts).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { PickedImage } from "../lib/attachments.ts";
import {
  readPhotoAsAttachment,
  readPhotoLibraryAccess,
  readRecentPhotos,
  requestPhotoLibraryAccess,
  type RecentPhoto,
} from "../lib/recent-photos.ts";
import { RECENT_PHOTOS_LIMIT } from "../lib/recent-photos-core.ts";
import { colors, radius, spacing } from "../lib/theme.ts";

/** As asked for: big enough to recognize a photo, small enough that the
 * composer stays a composer. The single knob for the strip's height. */
const TILE = 100;

export function RecentPhotosStrip(props: {
  attachments: PickedImage[];
  onAttachmentsChange: (attachments: PickedImage[]) => void;
  /** Opens the full-screen system picker — the same thing the composer's +
   * button does. It rides along at the END of the strip because that is
   * where you are when the strip ran out of what you wanted. */
  onPickMore: () => void;
  /** True while a capture is in flight — the sheet's attachments are being
   * sent, so the strip must not mutate them underneath it. */
  disabled: boolean;
}) {
  const cache = useQueryClient();
  const accessKey = ["photo-library-access"];
  const access = useQuery({
    queryKey: accessKey,
    queryFn: readPhotoLibraryAccess,
    staleTime: Infinity,
  });
  const photos = useQuery({
    queryKey: ["recent-photos"],
    queryFn: () => readRecentPhotos(RECENT_PHOTOS_LIMIT),
    enabled: access.data === "granted",
    staleTime: 30_000,
  });

  const allow = useMutation({
    mutationFn: requestPhotoLibraryAccess,
    onSuccess: (answer) => cache.setQueryData(accessKey, answer),
  });
  const attach = useMutation({
    mutationFn: readPhotoAsAttachment,
    onSuccess: (picked) => props.onAttachmentsChange([...props.attachments, picked]),
  });

  if (access.data === "unavailable" || access.data === undefined) return null;

  if (access.data === "ask") {
    return (
      <View style={styles.row}>
        <Pressable
          accessibilityLabel="Show recent photos"
          accessibilityRole="button"
          disabled={allow.isPending}
          onPress={() => allow.mutate()}
          style={[styles.tile, styles.askTile]}
        >
          {allow.isPending ? (
            <ActivityIndicator accessibilityLabel="Loading" color={colors.textMuted} size="small" />
          ) : (
            <Text style={styles.askText}>Recent{"\n"}photos</Text>
          )}
        </Pressable>
      </View>
    );
  }

  const roll = photos.data || [];
  if (roll.length === 0) return null;

  return (
    <View>
      {attach.error !== null ? <Text style={styles.error}>{attach.error.message}</Text> : null}
      <ScrollView
        contentContainerStyle={styles.row}
        horizontal
        keyboardShouldPersistTaps="handled"
        showsHorizontalScrollIndicator={false}
      >
        {roll.map((photo, index) => (
          <Tile
            key={photo.assetId}
            attached={props.attachments.some((image) => image.assetId === photo.assetId)}
            disabled={props.disabled}
            loading={attach.isPending && attach.variables?.assetId === photo.assetId}
            onAttach={() => attach.mutate(photo)}
            onDetach={() =>
              props.onAttachmentsChange(
                props.attachments.filter((image) => image.assetId !== photo.assetId),
              )
            }
            photo={photo}
            position={index + 1}
          />
        ))}
        <Pressable
          accessibilityLabel="Choose from all photos"
          accessibilityRole="button"
          disabled={props.disabled}
          onPress={props.onPickMore}
          style={[styles.tile, styles.askTile]}
        >
          <Text style={styles.moreGlyph}>+</Text>
          <Text style={styles.askText}>All photos</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

function Tile(props: {
  photo: RecentPhoto;
  position: number;
  attached: boolean;
  loading: boolean;
  disabled: boolean;
  onAttach: () => void;
  onDetach: () => void;
}) {
  return (
    <Pressable
      // The label carries the state, so "tap to attach" and "tap again to
      // remove" are two different controls to a screen reader (and to the
      // browser spec).
      accessibilityLabel={
        props.attached
          ? `Remove recent photo ${props.position}`
          : `Attach recent photo ${props.position}`
      }
      accessibilityRole="button"
      accessibilityState={{ selected: props.attached }}
      disabled={props.disabled || props.loading}
      onPress={props.attached ? props.onDetach : props.onAttach}
      style={styles.tile}
    >
      <Image source={{ uri: props.photo.previewUri }} style={styles.thumb} />
      {props.attached ? (
        <View style={styles.check}>
          <Text style={styles.checkText}>✓</Text>
        </View>
      ) : null}
      {props.loading ? (
        <View style={styles.loading}>
          <ActivityIndicator accessibilityLabel="Loading" color={colors.text} size="small" />
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    // The strip is not allowed to crowd the thing you came here to type in.
    paddingBottom: spacing.sm,
  },
  tile: {
    width: TILE,
    height: TILE,
    borderRadius: radius.sm,
    overflow: "hidden",
  },
  thumb: { width: TILE, height: TILE, backgroundColor: colors.surface },
  askTile: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
  },
  askText: { color: colors.textMuted, fontSize: 13, textAlign: "center" },
  moreGlyph: { color: colors.textMuted, fontSize: 24, lineHeight: 28 },
  check: {
    position: "absolute",
    top: spacing.xs,
    right: spacing.xs,
    width: 22,
    height: 22,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  checkText: { color: colors.background, fontSize: 13, fontWeight: "700" },
  loading: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#0b0b0fcc",
  },
  error: {
    color: colors.danger,
    fontSize: 12,
    paddingBottom: spacing.xs,
    paddingHorizontal: spacing.md,
  },
});
