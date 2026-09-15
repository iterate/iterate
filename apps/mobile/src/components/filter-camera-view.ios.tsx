import { Component } from "react";
import {
  ActivityIndicator,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type NativeSyntheticEvent,
  type ViewProps,
} from "react-native";
import { requireNativeView } from "expo";
import * as FileSystem from "expo-file-system/legacy";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NativeFilterSettings } from "../lib/filters/native-engine.ts";
import {
  DEFAULT_ADJUST,
  DEFAULT_MASK_STRETCH,
  parseAdjust,
  parseMaskStretch,
} from "../lib/filters/preferences.ts";
import type { FeatureHit } from "../lib/filters/definitions.ts";
import { NATIVE_FILTER_SOURCE } from "../lib/filters/native-runtime.generated.ts";
import type { FilterCameraProps } from "./filter-camera-types.ts";

type Preferences = NativeFilterSettings["adjust"] & {
  mode: "hole" | "features" | "face";
  maskStretch: NativeFilterSettings["maskStretch"];
};
const defaultPreferences: Preferences = { ...DEFAULT_ADJUST, maskStretch: DEFAULT_MASK_STRETCH };
const preferenceKey = "iterate.nativeFilterPreferences.v1";
type Status = {
  recording: boolean;
  ready: boolean;
  loading: boolean;
  error: string | null;
  tracked: boolean;
  microphone: boolean;
  width: number;
  height: number;
  featureHits: FeatureHit[];
  modes: string[];
  modes2: string[];
  actions: { id: string; label: string }[];
};
type NativeProps = ViewProps & {
  runtime: string;
  settings: string;
  facing: string;
  command: FilterCameraProps["command"];
  retryToken: number;
  onStatus: (event: NativeSyntheticEvent<Partial<Status>>) => void;
  onPhoto: (event: NativeSyntheticEvent<{ uri: string; width: number; height: number }>) => void;
  onVideo: (
    event: NativeSyntheticEvent<{
      uri: string;
      mimeType: string;
      durationSeconds: number;
      width: number;
      height: number;
      droppedFrames: number;
    }>,
  ) => void;
  onCaptureError: (event: NativeSyntheticEvent<{ message: string }>) => void;
};
const NativeCamera = requireNativeView<NativeProps>("IterateFilterCamera");

export default function FilterCameraView(props: FilterCameraProps) {
  const client = useQueryClient();
  const preferences = useQuery({
    queryKey: [preferenceKey],
    queryFn: async () => {
      const stored = await AsyncStorage.getItem(preferenceKey);
      if (!stored) return defaultPreferences;
      const value: unknown = JSON.parse(stored);
      const adjust = parseAdjust(value);
      const maskStretch =
        typeof value === "object" && value && "maskStretch" in value
          ? parseMaskStretch(value.maskStretch)
          : null;
      if (!adjust || !maskStretch)
        throw new Error("Saved filter settings are invalid. Reset them to continue.");
      return { ...adjust, maskStretch };
    },
  });
  const save = useMutation({
    mutationFn: async (value: Preferences) => {
      await AsyncStorage.setItem(preferenceKey, JSON.stringify(value));
      client.setQueryData([preferenceKey], value);
    },
  });
  if (preferences.isError)
    return (
      <View style={styles.message}>
        <Text style={styles.text}>{preferences.error.message}</Text>
        <Pressable accessibilityRole="button" onPress={() => save.mutate(defaultPreferences)}>
          <Text style={styles.text}>Reset settings</Text>
        </Pressable>
      </View>
    );
  if (!preferences.data) return <ActivityIndicator style={styles.fill} />;
  return (
    <>
      <NativeFilterCamera
        {...props}
        preferences={preferences.data}
        savePreferences={(value) => save.mutate(value)}
      />
      {save.isError ? <Text style={styles.error}>{save.error.message}</Text> : null}
    </>
  );
}

type CameraState = {
  status: Status;
  preferences: Preferences;
  backgroundIndex: number;
  modeIndex: number;
  modeIndex2: number;
  action: NativeFilterSettings["action"];
  tap: NativeFilterSettings["tap"];
  drag: NativeFilterSettings["drag"];
  retryToken: number;
};
class NativeFilterCamera extends Component<
  FilterCameraProps & { preferences: Preferences; savePreferences: (value: Preferences) => void },
  CameraState
> {
  state: CameraState = {
    status: {
      recording: false,
      ready: false,
      loading: false,
      error: null,
      tracked: false,
      microphone: true,
      width: 720,
      height: 1280,
      featureHits: [],
      modes: [],
      modes2: [],
      actions: [],
    },
    preferences: this.props.preferences,
    backgroundIndex: 0,
    modeIndex: 0,
    modeIndex2: 0,
    action: null,
    tap: null,
    drag: null,
    retryToken: 0,
  };
  private layoutWidth = 1;
  private disposed = false;
  private pointer: {
    x: number;
    y: number;
    hit: FeatureHit | undefined;
    preferences: Preferences;
    moved: boolean;
  } | null = null;
  private dragSequence = 0;
  componentWillUnmount() {
    this.disposed = true;
  }

  private gesture = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: (event) => {
      const { locationX: x, locationY: y } = event.nativeEvent;
      const scale = this.state.status.width / this.layoutWidth;
      const hit = this.state.status.featureHits
        .filter((hit) => Math.hypot(hit.cx - x * scale, hit.cy - y * scale) < hit.radius * 1.8)
        .sort(
          (a, b) =>
            Math.hypot(a.cx - x * scale, a.cy - y * scale) -
            Math.hypot(b.cx - x * scale, b.cy - y * scale),
        )[0];
      this.pointer = { x, y, hit, preferences: this.state.preferences, moved: false };
      this.dragSequence += 1;
    },
    onPanResponderMove: (_event, gesture) => {
      const pointer = this.pointer;
      if (!pointer || (!pointer.moved && Math.hypot(gesture.dx, gesture.dy) < 12)) return;
      pointer.moved = true;
      const previous = pointer.preferences;
      if (previous.mode !== "hole") {
        const key = previous.mode === "features" ? "featureScale" : "faceScale";
        this.setState({
          preferences: {
            ...this.state.preferences,
            [key]: Math.min(2.5, Math.max(0.4, previous[key] * (1 - gesture.dy / 280))),
          },
        });
      } else if (pointer.hit) {
        const kind = pointer.hit.kind,
          stretch = previous.maskStretch[kind];
        this.setState({
          preferences: {
            ...this.state.preferences,
            maskStretch: {
              ...previous.maskStretch,
              [kind]: {
                x: Math.min(3, Math.max(0.35, stretch.x * (1 + gesture.dx / 240))),
                y: Math.min(3, Math.max(0.35, stretch.y * (1 + gesture.dy / 240))),
              },
            },
          },
        });
      } else {
        const scale = this.state.status.width / this.layoutWidth;
        this.setState({
          drag: {
            startX: pointer.x * scale,
            startY: pointer.y * scale,
            dx: gesture.dx * scale,
            dy: gesture.dy * scale,
            active: true,
            seq: this.dragSequence,
          },
        });
      }
    },
    onPanResponderRelease: () => this.releasePointer(),
    onPanResponderTerminate: () => {
      this.pointer = null;
      if (this.state.drag) this.setState({ drag: { ...this.state.drag, active: false } });
    },
  });

  private releasePointer() {
    const pointer = this.pointer;
    this.pointer = null;
    if (!pointer) return;
    if (!pointer.moved) {
      const scale = this.state.status.width / this.layoutWidth;
      this.setState({
        backgroundIndex: this.state.backgroundIndex + 1,
        tap: { x: pointer.x * scale, y: pointer.y * scale, seq: (this.state.tap?.seq || 0) + 1 },
      });
    } else this.props.savePreferences(this.state.preferences);
    if (this.state.drag) this.setState({ drag: { ...this.state.drag, active: false } });
  }

  render() {
    const { status, preferences } = this.state;
    const settings: NativeFilterSettings = {
      filterId: this.props.filterId,
      dynamicFilters: this.props.dynamicFilters,
      backgroundIndex: this.state.backgroundIndex,
      modeIndex: this.state.modeIndex,
      modeIndex2: this.state.modeIndex2,
      action: this.state.action,
      tap: this.state.tap,
      drag: this.state.drag,
      adjust: { featureScale: preferences.featureScale, faceScale: preferences.faceScale },
      maskStretch: preferences.maskStretch,
    };
    const recording = status.recording;
    return (
      <View
        style={styles.fill}
        onLayout={(event) => {
          this.layoutWidth = event.nativeEvent.layout.width;
        }}
      >
        <NativeCamera
          style={styles.fill}
          runtime={NATIVE_FILTER_SOURCE}
          settings={JSON.stringify(settings)}
          facing={this.props.facing}
          command={this.props.command}
          retryToken={this.state.retryToken}
          onStatus={({ nativeEvent }) =>
            this.setState({ status: { ...this.state.status, ...nativeEvent } })
          }
          onPhoto={({ nativeEvent }) => {
            void (async () => {
              try {
                const base64 = await FileSystem.readAsStringAsync(nativeEvent.uri, {
                  encoding: FileSystem.EncodingType.Base64,
                });
                if (!this.disposed)
                  await this.props.onPhoto({
                    base64,
                    width: nativeEvent.width,
                    height: nativeEvent.height,
                  });
              } catch (error) {
                if (!this.disposed)
                  await this.props.onCaptureError(
                    error instanceof Error ? error.message : String(error),
                  );
              } finally {
                await FileSystem.deleteAsync(nativeEvent.uri, { idempotent: true }).catch((error) =>
                  console.error("Could not remove captured photo", error),
                );
              }
            })();
          }}
          onVideo={({ nativeEvent }) => {
            if (this.disposed) {
              void FileSystem.deleteAsync(nativeEvent.uri, { idempotent: true }).catch((error) =>
                console.error("Could not remove canceled recording", error),
              );
              return;
            }
            if (nativeEvent.droppedFrames)
              console.warn("Filter video encoder dropped frames", {
                droppedFrames: nativeEvent.droppedFrames,
                durationSeconds: nativeEvent.durationSeconds,
              });
            void this.props
              .onVideo(nativeEvent)
              .catch((error) =>
                this.props.onCaptureError(error instanceof Error ? error.message : String(error)),
              );
          }}
          onCaptureError={({ nativeEvent }) => {
            void this.props.onCaptureError(nativeEvent.message);
          }}
        />
        <View style={StyleSheet.absoluteFill} {...this.gesture.panHandlers} />
        {status.error ? (
          <View style={styles.message}>
            <Text style={styles.text}>{status.error}</Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => this.setState({ retryToken: this.state.retryToken + 1 })}
            >
              <Text style={styles.text}>Retry</Text>
            </Pressable>
          </View>
        ) : !status.ready || status.loading ? (
          <View style={styles.message} accessibilityRole="progressbar">
            <ActivityIndicator color="white" />
            <Text style={styles.text}>{status.ready ? "Loading filter…" : "Opening camera…"}</Text>
          </View>
        ) : null}
        {!recording ? (
          <ScrollView horizontal style={styles.controls} contentContainerStyle={styles.row}>
            {status.modes.length > 1 ? (
              <Pressable
                accessibilityRole="button"
                style={styles.button}
                onPress={() => this.setState({ modeIndex: this.state.modeIndex + 1 })}
              >
                <Text style={styles.text}>
                  {status.modes[this.state.modeIndex % status.modes.length]}
                </Text>
              </Pressable>
            ) : null}
            {status.modes2.length > 1 ? (
              <Pressable
                accessibilityRole="button"
                style={styles.button}
                onPress={() => this.setState({ modeIndex2: this.state.modeIndex2 + 1 })}
              >
                <Text style={styles.text}>
                  {status.modes2[this.state.modeIndex2 % status.modes2.length]}
                </Text>
              </Pressable>
            ) : null}
            {status.actions.map((action) => (
              <Pressable
                accessibilityRole="button"
                key={action.id}
                style={styles.button}
                onPress={() =>
                  this.setState({
                    action: { id: action.id, seq: (this.state.action?.seq || 0) + 1 },
                  })
                }
              >
                <Text style={styles.text}>{action.label}</Text>
              </Pressable>
            ))}
            <Pressable
              accessibilityRole="button"
              style={styles.button}
              onPress={() => {
                const order: Preferences["mode"][] = ["hole", "features", "face"];
                const next = {
                  ...preferences,
                  mode: order[(order.indexOf(preferences.mode) + 1) % order.length],
                };
                this.setState({ preferences: next });
                this.props.savePreferences(next);
              }}
            >
              <Text style={styles.text}>
                {{ hole: "✏️ holes", features: "🔍 size", face: "😐 face" }[preferences.mode]}
              </Text>
            </Pressable>
          </ScrollView>
        ) : null}
        {status.ready && !status.microphone ? (
          <Text style={styles.note}>
            Photos only — allow microphone access for video and singing.
          </Text>
        ) : null}
      </View>
    );
  }
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  text: { color: "white", fontSize: 13 },
  message: {
    position: "absolute",
    top: "20%",
    alignSelf: "center",
    maxWidth: "90%",
    backgroundColor: "#0b0b0fbf",
    padding: 12,
    borderRadius: 16,
    gap: 8,
    alignItems: "center",
  },
  controls: { position: "absolute", bottom: 150, left: 0, right: 0, flexGrow: 0 },
  row: {
    flexGrow: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
  },
  button: { backgroundColor: "#0b0b0fbf", padding: 12, borderRadius: 999 },
  note: {
    position: "absolute",
    bottom: 200,
    color: "white",
    alignSelf: "center",
    backgroundColor: "#0b0b0fbf",
    padding: 8,
  },
  error: { color: "#ff8080" },
});
