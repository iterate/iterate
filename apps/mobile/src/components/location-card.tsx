// A shared location rendered as a real little map instead of raw XML: OSM
// raster tiles stitched around the coordinate (lib/location-map.ts), a pin
// in the middle, accuracy underneath. Tapping asks Apple Maps or Google
// Maps — universal https links, so whichever is installed opens natively.

import {
  ActionSheetIOS,
  Alert,
  Image,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { MAP_ZOOM, mapsUrls, osmTileGrid } from "../lib/location-map.ts";
import { colors, radius, spacing } from "../lib/theme.ts";

const CARD_HEIGHT = 150;

export function LocationCard(props: {
  location: { latitude: number; longitude: number; accuracyMeters: number | null };
  width: number;
}) {
  const grid = osmTileGrid({
    latitude: props.location.latitude,
    longitude: props.location.longitude,
    zoom: MAP_ZOOM,
    width: props.width,
    height: CARD_HEIGHT,
  });
  const urls = mapsUrls(props.location);
  const open = () => {
    if (Platform.OS === "web") {
      // A browser IS a maps client — no chooser dialog to speak of there.
      window.open(urls.google, "_blank");
      return;
    }
    const choose = (choice: "apple" | "google" | null) => {
      if (choice !== null) void Linking.openURL(urls[choice]);
    };
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        { cancelButtonIndex: 2, options: ["Open in Apple Maps", "Open in Google Maps", "Cancel"] },
        (index) => choose(index === 0 ? "apple" : index === 1 ? "google" : null),
      );
      return;
    }
    Alert.alert("Open location", undefined, [
      { text: "Apple Maps", onPress: () => choose("apple") },
      { text: "Google Maps", onPress: () => choose("google") },
      { text: "Cancel", style: "cancel" },
    ]);
  };
  return (
    <Pressable
      accessibilityLabel={`Open location ${props.location.latitude.toFixed(5)}, ${props.location.longitude.toFixed(5)} in maps`}
      accessibilityRole="button"
      onPress={open}
      style={{ width: props.width }}
    >
      <View style={[styles.map, { width: props.width }]}>
        {grid.tiles.map((tile) => (
          <Image
            key={tile.url}
            source={{ uri: tile.url }}
            style={{
              position: "absolute",
              left: tile.left,
              top: tile.top,
              width: 256,
              height: 256,
            }}
          />
        ))}
        <View pointerEvents="none" style={styles.pinWrap}>
          {/* Tip of the pin on the exact coordinate: the glyph is bottom-
              anchored to the card's center point. */}
          <Ionicons name="location" size={34} color={colors.danger} style={styles.pin} />
        </View>
        <Text style={styles.attribution}>© OpenStreetMap</Text>
      </View>
      <View style={styles.meta}>
        <Ionicons name="navigate" size={13} color={colors.textMuted} />
        <Text numberOfLines={1} style={styles.metaText}>
          {props.location.latitude.toFixed(5)}, {props.location.longitude.toFixed(5)}
          {props.location.accuracyMeters === null ? "" : ` · ±${props.location.accuracyMeters}m`}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  map: {
    height: CARD_HEIGHT,
    overflow: "hidden",
    backgroundColor: colors.surface,
  },
  pinWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  pin: {
    // Bottom-anchor the pin glyph so its point marks the spot.
    transform: [{ translateY: -15 }],
    textShadowColor: "#0b0b0f88",
    textShadowRadius: 4,
  },
  attribution: {
    position: "absolute",
    bottom: 2,
    right: 4,
    color: "#333",
    backgroundColor: "#ffffffaa",
    fontSize: 8,
    paddingHorizontal: 3,
    borderRadius: radius.sm,
    overflow: "hidden",
  },
  meta: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
  },
  metaText: { color: colors.textMuted, fontSize: 12 },
});
