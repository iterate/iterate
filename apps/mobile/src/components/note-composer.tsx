// The global note-capture overlay — the reason the app exists at the moment
// you open it (grill decisions D2/D3): a composer docked above every screen
// (except chat, which has its own), auto-appearing on cold start and on
// foreground after a while away; ✕ collapses it to a floating 📝 pill.
//
// Where a note goes (convergence model): inside project/[projectId]/* it
// becomes a markdown file in the project's notes repo — written through the
// notes workspace, with a notes/captured fact appended to the workspace's
// stream. Anywhere else — or when the write fails — it lands in the local
// pending-notes store (lib/pending-notes.ts), and a drain prompt offers to
// store pending notes whenever a project is opened. Photo attachments upload
// to itx.files and double-append onto /media with source "note" so the media
// pipeline analyzes them for free.

import { useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Crypto from "expo-crypto";
import { router, useGlobalSearchParams, useSegments } from "expo-router";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { base64ToUint8Array, pickImages, type PickedImage } from "../lib/attachments.ts";
import { getProjectItx } from "../lib/itx.ts";
import {
  buildUploadedEvent,
  MEDIA_STREAM_PATH,
  mediaFilePath,
  readWipeGeneration,
} from "../lib/media.ts";
import {
  buildCapturedEvent,
  composeNoteFile,
  noteFilePath,
  NOTES_REPO_PATH,
  NOTES_WORKSPACE_PATH,
  type NoteAttachment,
} from "../lib/notes.ts";
import {
  addPendingNote,
  drainPendingNotes,
  readPendingNotes,
  removePendingNotes,
  type PendingNote,
} from "../lib/pending-notes.ts";
import { queryClient } from "../lib/query.ts";
import { DEFAULT_SERVER } from "../lib/servers.ts";
import { getServerBaseUrl } from "../lib/storage.ts";
import { colors, radius, spacing } from "../lib/theme.ts";

/** Backgrounded longer than this → the composer re-expands on return: you
 * probably came back to capture something. */
export const NOTE_COMPOSER_REAPPEAR_AFTER_MS = 5 * 60_000;

// Composer open/collapsed state and the drain-prompt generation live in the
// query cache (the drawer's open-state precedent) so the module-level
// AppState listener below can flip them without any component hook.
const composerOpenKey = ["note-composer-open"];
const drainGenerationKey = ["note-drain-generation"];

let lastLeftForegroundAt = 0;
AppState.addEventListener("change", (state) => {
  if (state !== "active") {
    lastLeftForegroundAt = Date.now();
    return;
  }
  if (
    lastLeftForegroundAt !== 0 &&
    Date.now() - lastLeftForegroundAt > NOTE_COMPOSER_REAPPEAR_AFTER_MS
  ) {
    queryClient.setQueryData(composerOpenKey, "auto");
    // A fresh "app open": drain prompts get another chance (D4).
    queryClient.setQueryData(drainGenerationKey, (generation: any) => (generation || 0) + 1);
  }
});

/** One-time-per-project (cached per app session): the notes repo + the
 * workspace that writes into it. Both creates are idempotent sagas, so a
 * repeat call after cache loss is a cheap no-op. */
async function ensureNotesProvisioned(project: any, projectId: string): Promise<void> {
  const flagKey = ["notes-provisioned", projectId];
  if (queryClient.getQueryData(flagKey)) return;
  await project.repos.get(NOTES_REPO_PATH).create({ type: "empty" });
  await project.workspaces.get(NOTES_WORKSPACE_PATH).create({});
  queryClient.setQueryData(flagKey, true);
}

/** Write the note FILE through the notes workspace (files are truth), then
 * append the notes/captured fact to the workspace's stream (the live/index
 * signal), double-appending photos onto /media. Used by direct capture and
 * the pending-notes drain — a drained note keeps its capturedOnDeviceAt and
 * noteKey, so retries and re-drains hit the same file path. */
async function appendNoteToProject(
  baseUrl: string,
  projectId: string,
  note: PendingNote,
): Promise<void> {
  const project = await getProjectItx(baseUrl, projectId);
  await ensureNotesProvisioned(project, projectId);
  const attachments: NoteAttachment[] = [];
  const wipeGeneration =
    note.attachments.length > 0
      ? await readWipeGeneration(project.streams.get(MEDIA_STREAM_PATH))
      : 0;
  for (const picked of note.attachments) {
    const stableKey = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      picked.base64,
    );
    const path = mediaFilePath(stableKey, picked.filename);
    await project.files.get(path).put({
      data: base64ToUint8Array(picked.base64),
      contentType: picked.contentType,
    });
    attachments.push({
      path,
      filename: picked.filename,
      contentType: picked.contentType,
      width: picked.width,
      height: picked.height,
    });
    // D7 double-append: the same bytes enter /media so its server-side
    // analysis obligation describes them and they show in the gallery.
    // Best-effort — a failure here only costs the gallery entry (the note
    // keeps its direct file reference).
    void project.streams
      .get(MEDIA_STREAM_PATH)
      .append(
        buildUploadedEvent({
          stableKey,
          wipeGeneration,
          filename: picked.filename,
          contentType: picked.contentType,
          width: picked.width,
          height: picked.height,
          source: "note",
          capturedAt: note.capturedOnDeviceAt,
          isScreenshot: null,
        }),
      )
      .catch(() => {});
  }
  const path = noteFilePath(note.capturedOnDeviceAt, note.noteKey);
  await project.workspaces.get(NOTES_WORKSPACE_PATH).writeFile(
    path,
    composeNoteFile(
      {
        capturedAt: note.capturedOnDeviceAt,
        ...(attachments.length > 0 && { attachments }),
      },
      note.text,
    ),
  );
  await project.streams.get(NOTES_WORKSPACE_PATH).append(buildCapturedEvent(path));
}

export function NoteCaptureOverlay() {
  const segments = useSegments();
  const params = useGlobalSearchParams<{ projectId?: string; slug?: string }>();
  const insets = useSafeAreaInsets();
  const cache = useQueryClient();
  const projectId = typeof params.projectId === "string" ? params.projectId : "";
  // Widened: expo-router's typed segments omit the index route, but at
  // runtime the sign-in screen yields [].
  const segmentList: string[] = segments;
  const inProject = segmentList[0] === "project" && projectId !== "";
  // Chat has its own composer — never stack two inputs.
  const onChatScreen = segmentList.includes("chat");
  // The sheet auto-expands only on LANDING surfaces — the projects list, a
  // project's home (chat list), and the /notes screen itself — the screens
  // you're on when "I opened the app to capture something" applies. On every
  // other screen a docked sheet covers real content (the sign-in CTA and the
  // notifications rows, per two Playwright-caught regressions), so those get
  // the pill; tapping it expands the composer anywhere.
  const autoExpands =
    segmentList[0] === "projects" ||
    (inProject && (segmentList.length === 2 || segmentList.at(-1) === "notes"));

  // "auto" = expanded on landing surfaces, pill elsewhere; "open" = the user
  // tapped the pill (expanded everywhere); "closed" = the user tapped ✕.
  const open = useQuery<"auto" | "open" | "closed">({
    queryKey: composerOpenKey,
    queryFn: async () => "auto" as const,
    initialData: "auto",
    staleTime: Infinity,
  });
  const expanded = open.data === "open" || (open.data === "auto" && autoExpands);
  const drainGeneration = useQuery({
    queryKey: drainGenerationKey,
    queryFn: async () => 0,
    initialData: 0,
    staleTime: Infinity,
  });
  const server = useQuery({
    queryKey: ["server"],
    queryFn: async () => (await getServerBaseUrl()) || DEFAULT_SERVER,
    staleTime: Infinity,
  });
  const baseUrl = server.data;
  const pending = useQuery({
    queryKey: ["pending-notes"],
    queryFn: () => readPendingNotes(AsyncStorage),
    staleTime: Infinity,
  });
  const pendingCount = (pending.data || []).length;

  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<PickedImage[]>([]);
  // Guards the delayed feedback reset: a send started within the previous
  // send's 6s feedback window bumps the generation, so the stale timer
  // no-ops instead of resetting the newer mutation's state mid-flight.
  const feedbackGeneration = useRef(0);

  const capture = useMutation({
    mutationFn: async (input: {
      text: string;
      files: PickedImage[];
    }): Promise<"sent" | "pending" | "saved-locally"> => {
      const note: PendingNote = {
        // Pure entropy: the file path (capturedOnDeviceAt stamp + this)
        // is the note's identity now.
        noteKey: Math.random().toString(36).slice(2, 8),
        text: input.text,
        capturedOnDeviceAt: new Date().toISOString(),
        attachments: input.files.map((file) => ({
          filename: file.filename,
          contentType: file.contentType,
          base64: file.base64,
          width: file.width,
          height: file.height,
        })),
      };
      if (!inProject || baseUrl === undefined) {
        await addPendingNote(AsyncStorage, note);
        return "pending";
      }
      try {
        await appendNoteToProject(baseUrl, projectId, note);
        return "sent";
      } catch {
        // Capture never loses data (D5): a failed append lands in the same
        // pending queue; the drain prompt recovers it later.
        await addPendingNote(AsyncStorage, note);
        return "saved-locally";
      }
    },
    onMutate: () => {
      feedbackGeneration.current += 1;
      setDraft("");
      setAttachments([]);
    },
    onError: (_error, input) => {
      // mutationFn already falls back to the pending queue for append
      // failures; this covers the queue write itself failing — the capture
      // must land back in the composer, never vanish.
      setDraft(input.text);
      setAttachments(input.files);
    },
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["pending-notes"] });
      // The captured fact normally reaches the notes screen over the live
      // socket; invalidating here covers a socket that's down or still
      // reconnecting, so a same-device capture always shows up.
      void cache.invalidateQueries({ queryKey: ["note-events"] });
      void cache.invalidateQueries({ queryKey: ["note-files"] });
      // Long enough to notice AND tap ("Note saved" links to /notes).
      const generation = feedbackGeneration.current;
      setTimeout(() => {
        if (feedbackGeneration.current === generation) capture.reset();
      }, 6_000);
    },
  });

  // The drain prompt (D4), keyed per project + app-open generation: fires
  // once when you're in a project with pending notes, and again only after
  // the next project switch or foreground return. Alert-in-a-queryFn keeps
  // the imperative dialog out of render without an effect hook.
  useQuery({
    queryKey: ["pending-notes-drain", projectId, drainGeneration.data],
    enabled: inProject && baseUrl !== undefined && pendingCount > 0,
    staleTime: Infinity,
    retry: false,
    queryFn: async () => {
      const notes = await readPendingNotes(AsyncStorage);
      if (notes.length === 0) return "nothing-pending";
      const label = notes.length === 1 ? "1 pending note" : `${notes.length} pending notes`;
      const store = await new Promise<boolean>((resolve) => {
        Alert.alert(
          `Store ${label}?`,
          `Captured outside a project. Store into ${params.slug || projectId}?`,
          [
            { text: "No", style: "cancel", onPress: () => resolve(false) },
            { text: "Store", onPress: () => resolve(true) },
          ],
        );
      });
      if (store) {
        const result = await drainPendingNotes(AsyncStorage, (note) =>
          appendNoteToProject(baseUrl!, projectId, note),
        );
        void cache.invalidateQueries({ queryKey: ["pending-notes"] });
        void cache.invalidateQueries({ queryKey: ["note-events"] });
        if (result.error !== null) {
          Alert.alert(
            "Some notes stayed pending",
            `${result.stored} stored, ${result.remaining} still pending: ${result.error}`,
          );
        }
        return "stored";
      }
      const keep = await new Promise<boolean>((resolve) => {
        Alert.alert(`Delete the ${label}?`, "Keeping them asks again next time.", [
          { text: "Keep pending", style: "cancel", onPress: () => resolve(true) },
          { text: "Delete", style: "destructive", onPress: () => resolve(false) },
        ]);
      });
      if (!keep) {
        await removePendingNotes(
          AsyncStorage,
          notes.map((note) => note.noteKey),
        );
        void cache.invalidateQueries({ queryKey: ["pending-notes"] });
        return "deleted";
      }
      return "kept";
    },
  });

  if (onChatScreen) return null;

  if (!expanded) {
    return (
      <View
        pointerEvents="box-none"
        style={[styles.overlay, { paddingBottom: insets.bottom + spacing.md }]}
      >
        <Pressable
          accessibilityLabel="Capture a note"
          accessibilityRole="button"
          onPress={() => cache.setQueryData(composerOpenKey, "open")}
          style={styles.pill}
        >
          <Text style={styles.pillText}>📝</Text>
          {pendingCount > 0 ? (
            <View style={styles.pillBadge}>
              <Text style={styles.pillBadgeText}>{pendingCount}</Text>
            </View>
          ) : null}
        </Pressable>
      </View>
    );
  }

  const canSend = draft.trim() !== "" || attachments.length > 0;
  const feedback =
    capture.data === "pending"
      ? "Saved on this phone — you'll be asked to store it when you open a project"
      : capture.data === "saved-locally"
        ? "Couldn't reach the project — saved on this phone instead"
        : null;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      pointerEvents="box-none"
      style={styles.overlay}
    >
      <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}>
        {attachments.length > 0 ? (
          <View style={styles.attachmentStrip}>
            {attachments.map((image) => (
              <Pressable
                key={image.previewUri}
                onPress={() =>
                  setAttachments(attachments.filter((a) => a.previewUri !== image.previewUri))
                }
              >
                <Image source={{ uri: image.previewUri }} style={styles.attachmentThumb} />
                <Text style={styles.attachmentRemove}>✕</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <View style={styles.headerRow}>
          <Text numberOfLines={1} style={styles.target}>
            {inProject
              ? `→ /notes in ${params.slug || projectId}`
              : `→ saved on this phone until you open a project${pendingCount > 0 ? ` (${pendingCount} pending)` : ""}`}
          </Text>
          <Pressable
            accessibilityLabel="Close note composer"
            accessibilityRole="button"
            hitSlop={10}
            onPress={() => cache.setQueryData(composerOpenKey, "closed")}
          >
            <Text style={styles.close}>✕</Text>
          </Pressable>
        </View>
        <View style={styles.composerRow}>
          <Pressable
            accessibilityLabel="Attach photos"
            disabled={capture.isPending}
            onPress={async () =>
              setAttachments([...attachments, ...(await pickImages({ selectionLimit: 4 }))])
            }
            style={styles.attach}
          >
            <Text style={styles.attachText}>+</Text>
          </Pressable>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            multiline
            placeholder="Capture a note"
            placeholderTextColor={colors.textFaint}
            style={styles.input}
          />
          <Pressable
            accessibilityLabel="Save note"
            accessibilityRole="button"
            disabled={!canSend || capture.isPending}
            onPress={() => {
              if (canSend && !capture.isPending) {
                capture.mutate({ text: draft.trim(), files: attachments });
              }
            }}
            style={[styles.send, (!canSend || capture.isPending) && { opacity: 0.4 }]}
          >
            {capture.isPending ? (
              // The first capture provisions the notes repo + workspace and
              // can take seconds — show it working, don't look dead.
              <ActivityIndicator
                accessibilityLabel="Loading"
                color={colors.background}
                size="small"
              />
            ) : (
              <Text style={styles.sendText}>↑</Text>
            )}
          </Pressable>
        </View>
        {capture.data === "sent" ? (
          // The confirmation doubles as the shortcut to what you just made.
          <Pressable
            accessibilityRole="link"
            onPress={() =>
              router.push({
                pathname: "/project/[projectId]/notes",
                params: { projectId, ...(params.slug && { slug: params.slug }) },
              })
            }
          >
            <Text style={styles.feedback}>
              Note saved — <Text style={styles.feedbackLink}>view in /notes</Text>
            </Text>
          </Pressable>
        ) : feedback !== null ? (
          <Text style={styles.feedback}>{feedback}</Text>
        ) : null}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "flex-end",
    alignItems: "stretch",
    zIndex: 30,
  },
  pill: {
    alignSelf: "flex-end",
    marginRight: spacing.md,
    width: 48,
    height: 48,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  pillText: { fontSize: 20 },
  pillBadge: {
    position: "absolute",
    top: -4,
    right: -4,
    minWidth: 18,
    height: 18,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
  },
  pillBadgeText: { color: colors.background, fontSize: 11, fontWeight: "700" },
  sheet: {
    backgroundColor: colors.surfaceRaised,
    borderTopColor: colors.border,
    borderTopWidth: 1,
    paddingTop: spacing.sm,
    gap: spacing.xs,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -3 },
    shadowOpacity: 0.25,
    shadowRadius: 10,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  target: { color: colors.textFaint, flex: 1, fontSize: 11 },
  close: { color: colors.textMuted, fontSize: 16, fontWeight: "600" },
  composerRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  attach: {
    width: 38,
    height: 38,
    borderRadius: radius.full,
    borderColor: colors.border,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  attachText: { color: colors.textMuted, fontSize: 20, lineHeight: 22 },
  input: {
    flex: 1,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    color: colors.text,
    fontSize: 15,
    maxHeight: 120,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
  },
  send: {
    backgroundColor: colors.accent,
    borderRadius: radius.full,
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
  },
  sendText: { color: colors.background, fontSize: 18, fontWeight: "700" },
  attachmentStrip: {
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  attachmentThumb: {
    width: 52,
    height: 52,
    borderRadius: radius.sm,
    borderColor: colors.border,
    borderWidth: 1,
  },
  attachmentRemove: {
    position: "absolute",
    top: -6,
    right: -6,
    color: colors.text,
    backgroundColor: colors.background,
    borderRadius: radius.full,
    width: 18,
    height: 18,
    textAlign: "center",
    fontSize: 11,
    lineHeight: 17,
    overflow: "hidden",
  },
  feedback: {
    color: colors.textMuted,
    fontSize: 12,
    paddingHorizontal: spacing.md,
  },
  feedbackLink: { color: colors.accent, fontWeight: "600" },
});
