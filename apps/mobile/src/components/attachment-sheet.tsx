// The + sheet, Telegram-style: a carousel of the last ~10 camera-roll
// photos/videos whose first tile is a LIVE camera preview (tap → full-screen
// capture), then a row of the other sendable things — All photos, Files,
// Audio recordings, Location. Rendered inline above the composer (the note
// composer's strip precedent), toggled by the + button.
//
// Carousel taps attach in place (multi-select feel, sheet stays open); the
// action rows and the camera close the sheet once they deliver, the way a
// full-screen picker naturally does.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Camera, CameraView } from "expo-camera";
import { formatClipDuration, type ComposerAttachment } from "../lib/composer-attachments.ts";
import { captureCurrentLocation, pickDocuments, pickLibraryMedia } from "../lib/pick-media.ts";
import { CAROUSEL_LIMIT, readMediaAsAttachment, readRecentMedia } from "../lib/recent-media.ts";
import { readPhotoLibraryAccess, requestPhotoLibraryAccess } from "../lib/recent-photos.ts";
import { colors, radius, spacing } from "../lib/theme.ts";
import { CameraCaptureModal } from "./camera-capture.tsx";

const TILE = 100;

export function AttachmentSheet(props: {
  /** Library asset ids already attached — their tiles show a check, and
   * tapping one again detaches it (the note strip's toggle semantics). */
  attachedAssetIds: string[];
  onAttach: (attachments: ComposerAttachment[]) => void;
  onDetachAsset: (assetId: string) => void;
  onClose: () => void;
}) {
  const cache = useQueryClient();
  const [cameraOpen, setCameraOpen] = useState(false);

  const accessKey = ["photo-library-access"];
  const access = useQuery({
    queryKey: accessKey,
    queryFn: readPhotoLibraryAccess,
    staleTime: Infinity,
  });
  const allow = useMutation({
    mutationFn: requestPhotoLibraryAccess,
    onSuccess: (answer) => cache.setQueryData(accessKey, answer),
  });
  const media = useQuery({
    queryKey: ["recent-media"],
    queryFn: () => readRecentMedia(CAROUSEL_LIMIT),
    enabled: access.data === "granted",
    // The clip you just recorded is the whole point — same staleTime: 0
    // reasoning as the note composer's strip.
    staleTime: 0,
  });

  const attachTile = useMutation({
    mutationFn: readMediaAsAttachment,
    onSuccess: (attachment) => props.onAttach([attachment]),
  });

  const openCamera = useMutation({
    mutationFn: async () => {
      const cameraPermission = await Camera.requestCameraPermissionsAsync();
      if (!cameraPermission.granted) {
        throw new Error("Camera permission was refused — allow it in Settings.");
      }
      // Mic too, so video clips have sound; a refusal still allows photos.
      await Camera.requestMicrophonePermissionsAsync().catch(() => {});
      setCameraOpen(true);
    },
  });

  const pickAll = useMutation({
    mutationFn: () => pickLibraryMedia({ selectionLimit: 6 }),
    onSuccess: (attachments) => {
      if (attachments.length > 0) {
        props.onAttach(attachments);
        props.onClose();
      }
    },
  });
  const pickFiles = useMutation({
    mutationFn: () => pickDocuments("any"),
    onSuccess: (attachments) => {
      if (attachments.length > 0) {
        props.onAttach(attachments);
        props.onClose();
      }
    },
  });
  const pickAudio = useMutation({
    mutationFn: () => pickDocuments("audio"),
    onSuccess: (attachments) => {
      if (attachments.length > 0) {
        props.onAttach(attachments);
        props.onClose();
      }
    },
  });
  const attachLocation = useMutation({
    mutationFn: captureCurrentLocation,
    onSuccess: (attachment) => {
      props.onAttach([attachment]);
      props.onClose();
    },
  });

  const rowError = [pickAll, pickFiles, pickAudio, attachLocation, attachTile, openCamera].find(
    (mutation) => mutation.error !== null,
  )?.error;

  const roll = media.data || [];
  // A browser has no camera or one-tap location; those stay native-only.
  const showCameraTile = Platform.OS !== "web";

  return (
    <View style={styles.sheet}>
      {rowError ? <Text style={styles.error}>{rowError.message}</Text> : null}
      {showCameraTile || access.data === "granted" || access.data === "ask" ? (
        <ScrollView
          contentContainerStyle={styles.carousel}
          horizontal
          keyboardShouldPersistTaps="handled"
          showsHorizontalScrollIndicator={false}
        >
          {showCameraTile ? (
            <CameraTile loading={openCamera.isPending} onPress={() => openCamera.mutate()} />
          ) : null}
          {access.data === "ask" ? (
            <Pressable
              accessibilityLabel="Show recent photos and videos"
              accessibilityRole="button"
              disabled={allow.isPending}
              onPress={() => allow.mutate()}
              style={[styles.tile, styles.plainTile]}
            >
              {allow.isPending ? (
                <ActivityIndicator
                  accessibilityLabel="Loading"
                  color={colors.textMuted}
                  size="small"
                />
              ) : (
                <Text style={styles.tileText}>Recent{"\n"}photos</Text>
              )}
            </Pressable>
          ) : null}
          {roll.map((item) => {
            const loading = attachTile.isPending && attachTile.variables?.assetId === item.assetId;
            const attached = props.attachedAssetIds.includes(item.assetId);
            return (
              <Pressable
                accessibilityLabel={
                  (attached ? "Detach recent " : "Attach recent ") +
                  (item.mediaType === "video" ? "video" : "photo")
                }
                accessibilityRole="button"
                accessibilityState={{ selected: attached }}
                disabled={loading}
                key={item.assetId}
                onPress={() =>
                  attached ? props.onDetachAsset(item.assetId) : attachTile.mutate(item)
                }
                style={styles.tile}
              >
                <Image source={{ uri: item.previewUri }} style={styles.thumb} />
                {item.mediaType === "video" ? (
                  <View style={styles.durationBadge}>
                    <Ionicons name="play" size={9} color={colors.text} />
                    <Text style={styles.durationText}>
                      {formatClipDuration(item.durationSeconds)}
                    </Text>
                  </View>
                ) : null}
                {attached ? (
                  <View style={styles.check}>
                    <Text style={styles.checkText}>✓</Text>
                  </View>
                ) : null}
                {loading ? (
                  <View style={styles.tileLoading}>
                    <ActivityIndicator
                      accessibilityLabel="Loading"
                      color={colors.text}
                      size="small"
                    />
                  </View>
                ) : null}
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
      {/* One horizontal row of the other sendable things, Telegram's bottom
          bar: icon in a circle, label underneath. */}
      <ScrollView
        contentContainerStyle={styles.actionRow}
        horizontal
        keyboardShouldPersistTaps="handled"
        showsHorizontalScrollIndicator={false}
      >
        <SheetAction
          icon="images-outline"
          label="All photos"
          loading={pickAll.isPending}
          onPress={() => pickAll.mutate()}
        />
        <SheetAction
          icon="document-outline"
          label="Files"
          loading={pickFiles.isPending}
          onPress={() => pickFiles.mutate()}
        />
        <SheetAction
          icon="musical-notes-outline"
          label="Audio"
          loading={pickAudio.isPending}
          onPress={() => pickAudio.mutate()}
        />
        {Platform.OS !== "web" ? (
          <SheetAction
            icon="location-outline"
            label="Location"
            loading={attachLocation.isPending}
            onPress={() => attachLocation.mutate()}
          />
        ) : null}
      </ScrollView>
      {cameraOpen ? (
        <CameraCaptureModal
          onCapture={(attachment) => {
            props.onAttach([attachment]);
            props.onClose();
          }}
          onClose={() => setCameraOpen(false)}
          visible={cameraOpen}
        />
      ) : null}
    </View>
  );
}

/** The live viewfinder tile — the box-camera way into full-screen capture. */
function CameraTile(props: { loading: boolean; onPress: () => void }) {
  const permission = useQuery({
    queryKey: ["camera-permission"],
    queryFn: async () => (await Camera.getCameraPermissionsAsync()).granted,
    staleTime: Infinity,
  });
  return (
    <Pressable
      accessibilityLabel="Open camera"
      accessibilityRole="button"
      disabled={props.loading}
      onPress={props.onPress}
      style={[styles.tile, styles.plainTile]}
    >
      {permission.data === true ? (
        <CameraView facing="back" style={StyleSheet.absoluteFill} />
      ) : null}
      <View style={styles.cameraGlyph}>
        {props.loading ? (
          <ActivityIndicator accessibilityLabel="Loading" color={colors.text} size="small" />
        ) : (
          <Ionicons name="videocam-outline" size={26} color={colors.text} />
        )}
      </View>
    </Pressable>
  );
}

function SheetAction(props: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  loading: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      disabled={props.loading}
      onPress={props.onPress}
      style={styles.action}
    >
      <View style={styles.actionCircle}>
        {props.loading ? (
          <ActivityIndicator accessibilityLabel="Loading" color={colors.textMuted} size="small" />
        ) : (
          <Ionicons name={props.icon} size={22} color={colors.text} />
        )}
      </View>
      <Text style={styles.actionLabel}>{props.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  sheet: {
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.sm,
    gap: spacing.sm,
  },
  carousel: {
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  tile: {
    width: TILE,
    height: TILE,
    borderRadius: radius.sm,
    overflow: "hidden",
  },
  plainTile: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
  },
  tileText: { color: colors.textMuted, fontSize: 13, textAlign: "center" },
  thumb: { width: TILE, height: TILE, backgroundColor: colors.surface },
  cameraGlyph: {
    width: 44,
    height: 44,
    borderRadius: radius.full,
    backgroundColor: "#0b0b0f88",
    alignItems: "center",
    justifyContent: "center",
  },
  durationBadge: {
    position: "absolute",
    bottom: spacing.xs,
    left: spacing.xs,
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    backgroundColor: "#0b0b0fbb",
    borderRadius: radius.sm,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  durationText: { color: colors.text, fontSize: 10 },
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
  tileLoading: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#0b0b0fcc",
  },
  actionRow: {
    flexDirection: "row",
    gap: spacing.lg,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xs,
  },
  action: { alignItems: "center", gap: 4, width: 64 },
  actionCircle: {
    width: 48,
    height: 48,
    borderRadius: radius.full,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  actionLabel: { color: colors.textMuted, fontSize: 11 },
  error: {
    color: colors.danger,
    fontSize: 12,
    paddingHorizontal: spacing.md,
  },
});
