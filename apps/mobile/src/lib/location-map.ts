// The maths behind the message-bubble map card: which OpenStreetMap raster
// tiles cover a card centered on a coordinate, and where the pin sits.
// Standard Web Mercator / slippy-map tile scheme
// (wiki.openstreetmap.org/wiki/Slippy_map_tilenames) — plain 256px PNGs from
// tile.openstreetmap.org, so the card needs no maps SDK, no API key, and no
// new native module. Pure geometry; the component just absolutely-positions
// the results.

export const OSM_TILE_SIZE = 256;
export const MAP_ZOOM = 15;

export type MapTile = {
  url: string;
  /** Position of the tile's top-left corner within the card, px. */
  left: number;
  top: number;
};

export function osmTileGrid(input: {
  latitude: number;
  longitude: number;
  zoom: number;
  /** Card dimensions, px. */
  width: number;
  height: number;
}): { tiles: MapTile[] } {
  const tileCount = 2 ** input.zoom;
  const xTile = ((input.longitude + 180) / 360) * tileCount;
  const latRadians = (input.latitude * Math.PI) / 180;
  const yTile =
    ((1 - Math.log(Math.tan(latRadians) + 1 / Math.cos(latRadians)) / Math.PI) / 2) * tileCount;

  // The coordinate's absolute pixel position on the world map at this zoom;
  // the card's top-left is half a card up-and-left of it.
  const centerX = xTile * OSM_TILE_SIZE;
  const centerY = yTile * OSM_TILE_SIZE;
  const originX = centerX - input.width / 2;
  const originY = centerY - input.height / 2;

  const tiles: MapTile[] = [];
  const firstX = Math.floor(originX / OSM_TILE_SIZE);
  const firstY = Math.floor(originY / OSM_TILE_SIZE);
  const lastX = Math.floor((originX + input.width) / OSM_TILE_SIZE);
  const lastY = Math.floor((originY + input.height) / OSM_TILE_SIZE);
  for (let x = firstX; x <= lastX; x++) {
    for (let y = firstY; y <= lastY; y++) {
      // Longitude wraps; latitude tiles outside the map are just skipped
      // (only reachable at polar coordinates no phone will report).
      if (y < 0 || y >= tileCount) continue;
      const wrappedX = ((x % tileCount) + tileCount) % tileCount;
      tiles.push({
        url: `https://tile.openstreetmap.org/${input.zoom}/${wrappedX}/${y}.png`,
        left: x * OSM_TILE_SIZE - originX,
        top: y * OSM_TILE_SIZE - originY,
      });
    }
  }
  return { tiles };
}

/** Universal https links — both open the native app when installed and a
 * browser otherwise, so the chooser works from any client. */
export function mapsUrls(location: { latitude: number; longitude: number }): {
  apple: string;
  google: string;
} {
  const at = `${location.latitude},${location.longitude}`;
  return {
    apple: `https://maps.apple.com/?ll=${at}&q=Shared%20location`,
    google: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(at)}`,
  };
}
