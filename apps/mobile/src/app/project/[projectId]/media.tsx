// Capture screenshots and photos into the project and search them by what
// they show. "Add" picks from the photo library (PHPicker — no permission,
// no native module, ships OTA). Per image: sha256 the payload, skip if the
// /media stream already has that idempotency key, upload bytes to itx.files,
// then one capabilityHost.runScript call does
// toMarkdown → vision transcript+tags → append server-side (lib/media.ts
// builds the script and owns the taxonomy). Picked items appear immediately
// as pending cards (three at a time in flight) and resolve into real rows as
// their events land on the live stream. Tap a thumbnail for full screen;
// "Re-analyze" reruns the pipeline and overlays the newest result.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Crypto from "expo-crypto";
import { Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { base64ToUint8Array, pickImages, type PickedImage } from "../../../lib/attachments.ts";
import { unsupportedImageReason } from "../../../lib/image-format.ts";
import { Markdown } from "../../../components/markdown.tsx";
import { MediaViewer } from "../../../components/media-viewer.tsx";
import { getProjectItx } from "../../../lib/itx.ts";
import {
  buildProcessScript,
  buildWipeScript,
  extendedSinceIso,
  readWipeGeneration,
  deriveMediaList,
  filterMedia,
  mapWithConcurrency,
  MEDIA_EVENT_TYPES,
  MEDIA_STREAM_PATH,
  MEDIA_TAGS,
  mediaFilePath,
  mediaIdempotencyKey,
  readAllMediaEvents,
  type MediaListItem,
} from "../../../lib/media.ts";
import { runSyncPass, type SyncPassResult } from "../../../lib/media-sync.ts";
import { DEFAULT_SERVER } from "../../../lib/servers.ts";
import {
  getMediaSyncSettings,
  getServerBaseUrl,
  setMediaSyncSettings,
  type MediaSyncSettings,
} from "../../../lib/storage.ts";
import { colors, radius, spacing } from "../../../lib/theme.ts";
import { useLiveEvents } from "../../../lib/use-live-events.ts";

type PendingItem = {
  previewUri: string;
  filename: string;
  status: "waiting" | "analyzing" | "skipped" | "error";
  error?: string;
};

export default function MediaScreen() {
  const { projectId, slug, q } = useLocalSearchParams<{
    projectId: string;
    slug?: string;
    /** Prefills search — in-app deep links (lib/in-app-links.ts) land here
     * with the linked item's filename. */
    q?: string;
  }>();
  const [query, setQuery] = useState(q || "");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [pending, setPending] = useState<PendingItem[]>([]);
  const [viewer, setViewer] = useState<{
    uri: string;
    title: string;
    tags: string[];
    markdown: string;
  } | null>(null);

  const server = useQuery({
    queryKey: ["server"],
    queryFn: async () => (await getServerBaseUrl()) || DEFAULT_SERVER,
    staleTime: Infinity,
  });
  const baseUrl = server.data;

  // Device-local per-project opt-in behind a confirm dialog — the row never
  // acts directly, so a fat-finger cannot start anything. Once confirmed,
  // a capped sync pass runs (the query's enabled flag) and again on every
  // screen open while on; the chosen back-to threshold is an absolute date.
  const queryClient = useQueryClient();
  const syncSettings = useQuery({
    queryKey: ["media-sync-settings", projectId],
    queryFn: () => getMediaSyncSettings(projectId),
    staleTime: Infinity,
  });
  const [syncDialogOpen, setSyncDialogOpen] = useState(false);
  const [syncProgress, setSyncProgress] = useState<string | null>(null);
  const settings = syncSettings.data;
  const syncPass = useQuery({
    queryKey: ["media-sync-pass", baseUrl || "pending", projectId, settings?.sinceIso || "off"],
    queryFn: async (): Promise<SyncPassResult> => {
      const project = await getProjectItx(baseUrl!, projectId);
      try {
        return await runSyncPass({
          project,
          since: settings!.sinceIso,
          onProgress: setSyncProgress,
          // Discovered screenshots appear immediately as pending cards with
          // local previews, exactly like picked ones, and resolve into real
          // rows as their captured events land on the live stream.
          onCandidate: (candidate) =>
            setPending((current) => [
              ...current,
              {
                previewUri: candidate.previewUri,
                filename: candidate.filename,
                status: "analyzing",
              },
            ]),
          onCandidateDone: (candidate, error) =>
            setPending((current) =>
              error === null
                ? current.filter((row) => row.previewUri !== candidate.previewUri)
                : current.map((row) =>
                    row.previewUri === candidate.previewUri
                      ? { ...row, status: "error", error }
                      : row,
                  ),
            ),
        });
      } finally {
        setSyncProgress(null);
      }
    },
    enabled: baseUrl !== undefined && settings?.enabled === true,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const wipe = useMutation({
    mutationFn: async () => {
      const project = await getProjectItx(baseUrl!, projectId);
      await project.capabilityHost.runScript(buildWipeScript(Date.now().toString(36)));
      // The wiped tombstone arrives over the live stream; deriveMediaList
      // resets on it — nothing to invalidate.
      setSyncDialogOpen(false);
    },
  });
  const applySyncSettings = (next: MediaSyncSettings) => {
    queryClient.setQueryData(["media-sync-settings", projectId], next);
    void setMediaSyncSettings(projectId, next);
    setSyncDialogOpen(false);
  };

  const events = useLiveEvents({
    queryKey: ["media-events", baseUrl || "pending", projectId],
    read: async () => {
      const project = await getProjectItx(baseUrl!, projectId);
      return await readAllMediaEvents(project.streams.get(MEDIA_STREAM_PATH));
    },
    enabled: baseUrl !== undefined,
    eventTypes: MEDIA_EVENT_TYPES,
    projectId,
    streamPath: MEDIA_STREAM_PATH,
  });

  const capture = useMutation({
    mutationFn: async () => {
      const picked = await pickImages({ selectionLimit: 20 });
      if (picked.length === 0) return;
      // Every picked image shows immediately; statuses update per item as
      // the three-wide pipeline works through them.
      setPending(
        picked.map((image) => ({
          previewUri: image.previewUri,
          filename: image.filename,
          status: "waiting" as const,
        })),
      );
      const setStatus = (image: PickedImage, status: PendingItem["status"], error?: string) =>
        setPending((current) =>
          current.map((row) =>
            row.previewUri === image.previewUri ? { ...row, status, error } : row,
          ),
        );
      const project = await getProjectItx(baseUrl!, projectId);
      const stream = project.streams.get(MEDIA_STREAM_PATH);
      const wipeGeneration = await readWipeGeneration(stream);
      await mapWithConcurrency(picked, 3, async (image) => {
        try {
          // Genuinely HEIC/AVIF payloads (rare now that the picker asks for
          // the compatible representation) would fail server-side in
          // toMarkdown — fail the card here with something actionable
          // instead of uploading bytes doomed to fail.
          const unsupported = unsupportedImageReason(image.contentType);
          if (unsupported !== null) {
            setStatus(image, "error", unsupported);
            return;
          }
          setStatus(image, "analyzing");
          const stableKey = await Crypto.digestStringAsync(
            Crypto.CryptoDigestAlgorithm.SHA256,
            image.base64,
          );
          if (
            await stream.getEvent({
              idempotencyKey: mediaIdempotencyKey(stableKey, wipeGeneration),
            })
          ) {
            setStatus(image, "skipped");
            return;
          }
          await project.files.get(mediaFilePath(stableKey, image.filename)).put({
            data: base64ToUint8Array(image.base64),
            contentType: image.contentType,
          });
          await project.capabilityHost.runScript(
            buildProcessScript({
              stableKey,
              wipeGeneration,
              filename: image.filename,
              contentType: image.contentType,
              width: image.width,
              height: image.height,
              source: "picker",
              capturedAt: null,
              isScreenshot: null,
              mode: "capture",
            }),
          );
          // The captured event arrives over the live connection and renders
          // as a real row; drop the pending card.
          setPending((current) => current.filter((row) => row.previewUri !== image.previewUri));
        } catch (error) {
          setStatus(image, "error", error instanceof Error ? error.message : String(error));
        }
      });
      // Skipped/errored cards stay visible until the next capture starts.
    },
  });

  const items = deriveMediaList(events.data || []);
  const visible = filterMedia(items, query, selectedTags);
  // Chips: taxonomy order first, then novel model-coined tags actually in use.
  const tagsInUse = new Set(items.flatMap((item) => item.payload.tags));
  const chipTags = [
    ...MEDIA_TAGS.map(({ tag }) => tag).filter((tag) => tagsInUse.has(tag)),
    ...[...tagsInUse].filter((tag) => !MEDIA_TAGS.some(({ tag: known }) => known === tag)).sort(),
  ];

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: slug ? `${slug} media` : "Media" }} />
      <View style={styles.toolbar}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search descriptions and text…"
          placeholderTextColor={colors.textFaint}
          style={styles.search}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Pressable
          accessibilityRole="button"
          onPress={() => capture.mutate()}
          disabled={capture.isPending || baseUrl === undefined}
          style={[styles.captureButton, capture.isPending && styles.captureDisabled]}
        >
          <Text style={styles.captureText}>+ Add</Text>
        </Pressable>
        <Pressable
          accessibilityLabel="Media options"
          accessibilityRole="button"
          onPress={() => setSyncDialogOpen(true)}
          style={styles.moreButton}
        >
          <Text style={styles.moreButtonText}>⋯</Text>
        </Pressable>
      </View>
      {settings?.enabled === true ? (
        // One unobtrusive line: the sync pass result plus the auto-collect
        // window ("back to <date>") — everything the old settings row said.
        // Turning it on/off lives behind the ⋯ dialog.
        <Text numberOfLines={1} style={styles.syncStatus}>
          {syncProgress ||
            (syncPass.isFetching
              ? "Syncing…"
              : syncPass.isError
                ? String(syncPass.error.message)
                : syncSummary(syncPass.data, settings.sinceIso))}
        </Text>
      ) : null}
      {chipTags.length > 0 ? (
        <View style={styles.chips}>
          {chipTags.map((tag) => {
            const selected = selectedTags.includes(tag);
            return (
              <Pressable
                key={tag}
                onPress={() =>
                  setSelectedTags(
                    selected ? selectedTags.filter((t) => t !== tag) : [...selectedTags, tag],
                  )
                }
                style={[styles.chip, selected && styles.chipSelected]}
              >
                <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{tag}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {capture.isError ? <Text style={styles.error}>{String(capture.error.message)}</Text> : null}
      {events.isPending ? (
        <View style={styles.center}>
          <ActivityIndicator accessibilityLabel="Loading" color={colors.textMuted} />
        </View>
      ) : events.isError ? (
        <View style={styles.center}>
          <Text style={styles.error}>{String(events.error.message)}</Text>
          <Pressable onPress={() => void events.refetch()} style={styles.retry}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : items.length === 0 && pending.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>Nothing here yet</Text>
          <Text style={styles.emptyBody}>
            Add screenshots or photos — each gets described and transcribed by a vision model, then
            you can search them here by what they show.
          </Text>
        </View>
      ) : visible.length === 0 && pending.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>No results</Text>
          <Text style={styles.emptyBody}>Nothing matches this search — try fewer words.</Text>
        </View>
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(item) => String(item.offset)}
          contentContainerStyle={{ padding: spacing.md, gap: spacing.sm }}
          refreshControl={
            // Stock pull-to-refresh: rereads the event log, drops settled
            // (errored/skipped) pending cards — sticky error cards in prod
            // often described items a later sync pass had captured fine —
            // and, with auto-collect on, kicks a sync pass (this replaced the
            // inline "Sync now" button; the dialog keeps one too). In-flight
            // cards stay; their statuses are still live. The spinner tracks
            // only the event reread — a sync pass can run for minutes and
            // reports through the status line instead.
            <RefreshControl
              refreshing={events.isRefetching}
              onRefresh={() => {
                setPending((current) =>
                  current.filter((row) => row.status === "waiting" || row.status === "analyzing"),
                );
                void events.refetch();
                if (settings?.enabled === true && !syncPass.isFetching) void syncPass.refetch();
              }}
              tintColor={colors.textMuted}
            />
          }
          ListHeaderComponent={
            pending.length > 0 ? (
              <View style={{ gap: spacing.sm, marginBottom: spacing.sm }}>
                {pending.map((row) => (
                  <PendingRow
                    key={row.previewUri}
                    onViewImage={(uri) => setViewer({ uri, title: "", tags: [], markdown: "" })}
                    row={row}
                  />
                ))}
              </View>
            ) : null
          }
          renderItem={({ item }) => (
            <MediaRow
              baseUrl={baseUrl!}
              item={item}
              onViewImage={(uri) =>
                setViewer({
                  uri,
                  title: item.payload.title,
                  tags: item.payload.tags,
                  markdown: item.payload.markdown,
                })
              }
              projectId={projectId}
            />
          )}
        />
      )}
      <Modal
        animationType="fade"
        onRequestClose={() => setSyncDialogOpen(false)}
        statusBarTranslucent
        transparent
        visible={syncDialogOpen}
      >
        <SyncDialog
          itemCount={items.length}
          onApply={applySyncSettings}
          onCancel={() => setSyncDialogOpen(false)}
          onSyncNow={() => {
            setSyncDialogOpen(false);
            void syncPass.refetch();
          }}
          onWipe={() => wipe.mutate()}
          settings={settings || null}
          syncFetching={syncPass.isFetching}
          wipePending={wipe.isPending}
        />
      </Modal>
      <Modal
        animationType="fade"
        onRequestClose={() => setViewer(null)}
        statusBarTranslucent
        transparent
        visible={viewer !== null}
      >
        {viewer ? (
          <MediaViewer
            markdown={viewer.markdown}
            onClose={() => setViewer(null)}
            tags={viewer.tags}
            title={viewer.title}
            uri={viewer.uri}
          />
        ) : null}
      </Modal>
    </View>
  );
}

const BACKFILL_WINDOWS = [
  { label: "1 day", days: 1 },
  { label: "1 week", days: 7 },
  { label: "1 month", days: 30 },
  { label: "3 months", days: 91 },
  { label: "1 year", days: 365 },
];

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

/** The options sheet behind the toolbar's ⋯ button: auto-collect on/off with
 * its backfill window, a manual Sync now, and Delete all. Nothing syncs
 * until "Turn on" — opening the sheet never acts. Extending the window
 * backwards later is the same dialog with a longer choice. */
function SyncDialog({
  settings,
  itemCount,
  onApply,
  onCancel,
  onSyncNow,
  onWipe,
  syncFetching,
  wipePending,
}: {
  settings: MediaSyncSettings | null;
  itemCount: number;
  onApply: (next: MediaSyncSettings) => void;
  onCancel: () => void;
  onSyncNow: () => void;
  onWipe: () => void;
  syncFetching: boolean;
  wipePending: boolean;
}) {
  const enabled = settings?.enabled === true;
  // Start on the chip closest to the CURRENT window when already on —
  // defaulting to "1 week" would make a reflexive Update silently shrink a
  // longer window (and apply extends only backwards regardless).
  const currentDays = enabled
    ? (Date.now() - new Date(settings!.sinceIso).getTime()) / 86_400_000
    : 7;
  const [windowDays, setWindowDays] = useState(
    () => BACKFILL_WINDOWS.find((option) => option.days >= currentDays - 0.5)?.days || 365,
  );
  const [confirmingWipe, setConfirmingWipe] = useState(false);
  const sinceIso = extendedSinceIso(
    enabled && settings ? settings.sinceIso : null,
    windowDays,
    Date.now(),
  );
  return (
    <View style={styles.dialogBackdrop}>
      <View style={styles.dialog}>
        <Text style={styles.dialogTitle}>Auto-collect screenshots</Text>
        <Text style={styles.dialogBody}>
          When on, opening this screen or pulling to refresh syncs screenshots from your photo
          library into this project — screenshots only, at most 50 per pass, and never older than
          the date you pick. Nothing happens until you confirm here.
        </Text>
        <Text style={styles.dialogSectionLabel}>Collect back to</Text>
        <View style={styles.chips}>
          {BACKFILL_WINDOWS.map((option) => {
            const selected = option.days === windowDays;
            return (
              <Pressable
                key={option.label}
                onPress={() => setWindowDays(option.days)}
                style={[styles.chip, selected && styles.chipSelected]}
              >
                <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
                  {option.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.dialogHint}>
          {`Screenshots taken since ${shortDate(sinceIso)}. Start small — you can extend further back here any time.`}
        </Text>
        {enabled && settings ? (
          <Text
            style={styles.dialogHint}
          >{`Currently on, back to ${shortDate(settings.sinceIso)}.`}</Text>
        ) : null}
        {enabled ? (
          // Pull-to-refresh is the everyday trigger; this is the explicit one.
          <Pressable
            accessibilityRole="button"
            disabled={syncFetching}
            onPress={onSyncNow}
            style={[
              styles.dialogButton,
              styles.syncNowButton,
              syncFetching && styles.captureDisabled,
            ]}
          >
            <Text style={styles.dialogButtonText}>{syncFetching ? "Syncing…" : "Sync now"}</Text>
          </Pressable>
        ) : null}
        {itemCount > 0 ? (
          confirmingWipe ? (
            <View style={styles.wipeConfirm}>
              <Text style={styles.wipeWarning}>
                {`Deletes all ${itemCount} items and their image files from this project, for everyone. Photos on your phone are untouched. This cannot be undone.`}
              </Text>
              <Pressable
                accessibilityRole="button"
                disabled={wipePending}
                onPress={onWipe}
                style={[styles.dialogButton, styles.wipeButton]}
              >
                <Text style={styles.wipeButtonText}>
                  {wipePending ? "Deleting…" : "Yes, delete everything"}
                </Text>
              </Pressable>
            </View>
          ) : (
            <Pressable accessibilityRole="button" onPress={() => setConfirmingWipe(true)}>
              <Text style={styles.wipeLink}>Delete all media from this project…</Text>
            </Pressable>
          )
        ) : null}
        <View style={styles.dialogActions}>
          <Pressable accessibilityRole="button" onPress={onCancel} style={styles.dialogButton}>
            <Text style={styles.dialogButtonText}>Cancel</Text>
          </Pressable>
          {enabled ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => settings && onApply({ enabled: false, sinceIso: settings.sinceIso })}
              style={styles.dialogButton}
            >
              <Text style={styles.dialogButtonText}>Turn off</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            onPress={() => onApply({ enabled: true, sinceIso })}
            style={[styles.dialogButton, styles.dialogButtonPrimary]}
          >
            <Text style={styles.dialogButtonPrimaryText}>{enabled ? "Update" : "Turn on"}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

/** The status line also carries the auto-collect window ("back to <date>") —
 * the old settings row's information, folded in when the ⋯ dialog replaced
 * the row. Last so a long summary truncates it first. */
function syncSummary(result: SyncPassResult | undefined, sinceIso: string): string {
  const backTo = `back to ${shortDate(sinceIso)}`;
  if (result === undefined) return `Auto-collect on · ${backTo}`;
  if (result.status === "denied") return "Photo access denied — allow it in Settings";
  const limited = result.accessPrivileges === "limited" ? " · limited access" : "";
  const more = result.more ? " · more next pass" : "";
  const failed = result.failed > 0 ? ` · ${result.failed} failed (will retry)` : "";
  return `Synced ${result.synced} new · ${result.known} already captured${failed}${more}${limited} · ${backTo}`;
}

function PendingRow({
  onViewImage,
  row,
}: {
  onViewImage: (uri: string) => void;
  row: PendingItem;
}) {
  return (
    <View style={[styles.row, row.status === "error" && styles.rowError]}>
      <Pressable accessibilityLabel="View full screen" onPress={() => onViewImage(row.previewUri)}>
        <Image source={{ uri: row.previewUri }} style={styles.thumb} />
      </Pressable>
      <View style={styles.rowBody}>
        <Text numberOfLines={1} style={styles.pendingFilename}>
          {row.filename}
        </Text>
        {row.status === "error" ? (
          <Text numberOfLines={3} style={styles.pendingError}>
            {row.error}
          </Text>
        ) : row.status === "skipped" ? (
          <Text style={styles.pendingStatus}>Already captured — skipped</Text>
        ) : (
          <View style={styles.pendingSpinnerRow}>
            <ActivityIndicator color={colors.textMuted} size="small" />
            <Text style={styles.pendingStatus}>
              {row.status === "waiting" ? "Waiting…" : "Analyzing…"}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

function MediaRow({
  baseUrl,
  item,
  onViewImage,
  projectId,
}: {
  baseUrl: string;
  item: MediaListItem;
  onViewImage: (uri: string) => void;
  projectId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const imageUrl = useQuery({
    queryKey: ["media-url", projectId, item.payload.path],
    queryFn: async () => {
      const project = await getProjectItx(baseUrl, projectId);
      return await project.files.get(item.payload.path).url();
    },
    staleTime: Infinity,
  });
  const reanalyze = useMutation({
    mutationFn: async () => {
      const project = await getProjectItx(baseUrl, projectId);
      await project.capabilityHost.runScript(
        buildProcessScript({
          stableKey: item.payload.stableKey,
          wipeGeneration: 0, // reprocess keys on its nonce, not the capture identity
          filename: item.payload.filename,
          contentType: item.payload.contentType,
          width: item.payload.width,
          height: item.payload.height,
          source: item.payload.source,
          capturedAt: item.payload.capturedAt,
          isScreenshot: item.payload.isScreenshot,
          mode: { reprocessNonce: Date.now().toString(36) },
        }),
      );
      // The processed event arrives over the live stream and re-renders the
      // row through deriveMediaList — nothing to invalidate here.
    },
  });

  return (
    <Pressable onPress={() => setExpanded(!expanded)} style={styles.row}>
      <Pressable
        accessibilityLabel="View full screen"
        disabled={imageUrl.data === undefined}
        onPress={() => imageUrl.data && onViewImage(imageUrl.data)}
      >
        {imageUrl.data ? (
          <Image source={{ uri: imageUrl.data }} style={styles.thumb} />
        ) : (
          <View style={[styles.thumb, styles.thumbPlaceholder]} />
        )}
      </Pressable>
      <View style={styles.rowBody}>
        {item.payload.title ? (
          <Text numberOfLines={expanded ? undefined : 1} style={styles.rowTitle}>
            {item.payload.title}
          </Text>
        ) : null}
        {item.payload.markdown ? (
          // Same renderer as chat messages; collapsed rows clip to a few
          // lines' height instead of clamping (EnrichedMarkdownText has no
          // numberOfLines).
          <View style={expanded ? undefined : styles.markdownCollapsed}>
            <Markdown markdown={item.payload.markdown} preview />
          </View>
        ) : (
          <Text style={styles.markdown}>(no description)</Text>
        )}
        {expanded && item.payload.transcript ? (
          <Text selectable style={styles.transcript}>
            {item.payload.transcript}
          </Text>
        ) : null}
        {expanded ? (
          // The original filename (IMG_1234.PNG), findable but faint — it's
          // also what in-app deep links search by. Expanded detail only; the
          // collapsed meta row is already full with tags + date.
          <Text numberOfLines={1} selectable style={styles.rowFilename}>
            {item.payload.filename}
          </Text>
        ) : null}
        <View style={styles.rowTags}>
          {item.payload.tags.map((tag) => (
            <Text key={tag} style={styles.rowTag}>
              {tag}
            </Text>
          ))}
          <Text style={styles.rowDate}>
            {new Date(item.payload.capturedAt || item.capturedAt).toLocaleDateString()}
          </Text>
        </View>
        {expanded ? (
          <Pressable
            accessibilityRole="button"
            disabled={reanalyze.isPending}
            onPress={() => reanalyze.mutate()}
            style={[styles.reanalyze, reanalyze.isPending && styles.captureDisabled]}
          >
            <Text style={styles.reanalyzeText}>
              {reanalyze.isPending ? "Re-analyzing…" : "Re-analyze"}
            </Text>
          </Pressable>
        ) : null}
        {reanalyze.isError ? (
          <Text style={styles.pendingError}>{String(reanalyze.error.message)}</Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  toolbar: {
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  search: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    color: colors.text,
    flex: 1,
    fontSize: 14,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
  },
  captureButton: {
    alignItems: "center",
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    justifyContent: "center",
    paddingHorizontal: spacing.md,
  },
  captureDisabled: { opacity: 0.5 },
  // The ⋯ options button: quiet next to the accent +Add, but the same
  // height and a comfortable tap target.
  moreButton: {
    alignItems: "center",
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    justifyContent: "center",
    paddingHorizontal: spacing.md,
  },
  moreButtonText: { color: colors.text, fontSize: 18, fontWeight: "600" },
  dialogBackdrop: {
    alignItems: "center",
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    flex: 1,
    justifyContent: "center",
    padding: spacing.lg,
  },
  dialog: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.lg,
    width: "100%",
  },
  dialogTitle: { color: colors.text, fontSize: 17, fontWeight: "600" },
  dialogBody: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  dialogSectionLabel: { color: colors.text, fontSize: 13, fontWeight: "600", marginTop: 4 },
  dialogHint: { color: colors.textFaint, fontSize: 12 },
  dialogActions: {
    flexDirection: "row",
    gap: spacing.sm,
    justifyContent: "flex-end",
    marginTop: spacing.sm,
  },
  dialogButton: {
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
  },
  dialogButtonText: { color: colors.text, fontSize: 14 },
  dialogButtonPrimary: { backgroundColor: colors.accent, borderColor: colors.accent },
  wipeLink: { color: colors.danger, fontSize: 13, marginTop: 4 },
  wipeConfirm: { gap: spacing.sm, marginTop: 4 },
  wipeWarning: { color: colors.danger, fontSize: 12, lineHeight: 17 },
  wipeButton: { alignSelf: "flex-start", borderColor: colors.danger },
  wipeButtonText: { color: colors.danger, fontSize: 14, fontWeight: "600" },
  dialogButtonPrimaryText: { color: colors.background, fontSize: 14, fontWeight: "600" },
  syncStatus: {
    color: colors.textMuted,
    fontSize: 12,
    paddingHorizontal: spacing.md,
    paddingTop: 4,
  },
  syncNowButton: { alignSelf: "flex-start" },
  captureText: { color: colors.background, fontSize: 14, fontWeight: "600" },
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  chip: {
    borderColor: colors.border,
    borderRadius: radius.full,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  chipSelected: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { color: colors.textMuted, fontSize: 12 },
  chipTextSelected: { color: colors.background, fontWeight: "600" },
  center: { alignItems: "center", flex: 1, justifyContent: "center", padding: spacing.xl },
  error: { color: colors.danger, fontSize: 13, padding: spacing.md },
  retry: {
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: 8,
  },
  retryText: { color: colors.text, fontSize: 14 },
  emptyTitle: { color: colors.text, fontSize: 16, fontWeight: "600" },
  emptyBody: {
    color: colors.textMuted,
    fontSize: 13,
    marginTop: spacing.sm,
    textAlign: "center",
  },
  row: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: "row",
    gap: spacing.md,
    padding: spacing.md,
  },
  rowError: { borderColor: colors.danger },
  thumb: { borderRadius: radius.sm, height: 96, width: 54 },
  thumbPlaceholder: { backgroundColor: colors.border },
  rowBody: { flex: 1, gap: spacing.xs },
  rowTitle: { color: colors.text, fontSize: 14, fontWeight: "600" },
  markdown: { color: colors.text, fontSize: 13, lineHeight: 18 },
  markdownCollapsed: { maxHeight: 76, overflow: "hidden" },
  transcript: {
    borderLeftColor: colors.border,
    borderLeftWidth: 2,
    color: colors.textMuted,
    fontFamily: "Menlo",
    fontSize: 11,
    lineHeight: 15,
    paddingLeft: spacing.sm,
  },
  rowFilename: { color: colors.textFaint, fontSize: 11 },
  rowTags: { alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  rowTag: {
    backgroundColor: colors.background,
    borderRadius: radius.sm,
    color: colors.textMuted,
    fontSize: 11,
    overflow: "hidden",
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  rowDate: { color: colors.textFaint, fontSize: 11, marginLeft: "auto" },
  pendingFilename: { color: colors.text, fontSize: 13, fontWeight: "500" },
  pendingSpinnerRow: { alignItems: "center", flexDirection: "row", gap: spacing.sm },
  pendingStatus: { color: colors.textMuted, fontSize: 12 },
  pendingError: { color: colors.danger, fontSize: 12 },
  reanalyze: {
    alignSelf: "flex-start",
    borderColor: colors.border,
    borderRadius: radius.sm,
    borderWidth: 1,
    marginTop: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  reanalyzeText: { color: colors.textMuted, fontSize: 12, fontWeight: "500" },
});
