import { expect, test } from "vitest";
import { MAP_ZOOM, mapsUrls, OSM_TILE_SIZE, osmTileGrid } from "./location-map.ts";

// Trafalgar Square — a coordinate whose slippy-map tile at z15 is a known
// quantity: x = (180 - 0.1278)/360 * 2^15 ≈ 16372.37, y ≈ 10896.66.
const LONDON = { latitude: 51.5074, longitude: -0.1278 };

test("the grid covers the card with correctly-addressed tiles", () => {
  const grid = osmTileGrid({ ...LONDON, zoom: MAP_ZOOM, width: 280, height: 150 });
  // 280px needs 2-3 tile columns, 150px needs 1-2 rows.
  expect(grid.tiles.length).toBeGreaterThanOrEqual(2);
  for (const tile of grid.tiles) {
    expect(tile.url).toMatch(/^https:\/\/tile\.openstreetmap\.org\/15\/163\d\d\/108\d\d\.png$/);
    // Every tile overlaps the card: starts before the card ends, ends after
    // the card starts.
    expect(tile.left).toBeLessThan(280);
    expect(tile.left + OSM_TILE_SIZE).toBeGreaterThan(0);
    expect(tile.top).toBeLessThan(150);
    expect(tile.top + OSM_TILE_SIZE).toBeGreaterThan(0);
  }
  // The coordinate lands at the card's center: exactly one tile contains the
  // center point, and its share of the world map puts London inside it.
  const containing = grid.tiles.filter(
    (tile) =>
      tile.left <= 140 &&
      tile.left + OSM_TILE_SIZE > 140 &&
      tile.top <= 75 &&
      tile.top + OSM_TILE_SIZE > 75,
  );
  expect(containing).toHaveLength(1);
  expect(containing[0]!.url).toContain("/15/16372/10896.png");
});

test("tiles butt against each other with no gaps", () => {
  const grid = osmTileGrid({ ...LONDON, zoom: MAP_ZOOM, width: 300, height: 300 });
  const lefts = [...new Set(grid.tiles.map((tile) => tile.left))].sort((a, b) => a - b);
  for (let i = 1; i < lefts.length; i++) {
    expect(lefts[i]! - lefts[i - 1]!).toBe(OSM_TILE_SIZE);
  }
});

test("longitude wraps at the antimeridian instead of requesting nonexistent tiles", () => {
  const grid = osmTileGrid({
    latitude: 0,
    longitude: 179.999,
    zoom: 3,
    width: 500,
    height: 100,
  });
  for (const tile of grid.tiles) {
    const x = Number(tile.url.match(/\/3\/(\d+)\//)![1]);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThan(8);
  }
});

test("maps links carry the coordinate for both vendors", () => {
  expect(mapsUrls(LONDON)).toMatchObject({
    apple: expect.stringContaining("51.5074,-0.1278"),
    google: expect.stringContaining("query=51.5074%2C-0.1278"),
  });
});
