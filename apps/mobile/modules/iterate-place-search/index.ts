import { iteratePlaceSearch, type NativePlace } from "./src/IteratePlaceSearchModule.ts";

export async function searchNearbyPlaces(input: {
  latitude: number;
  longitude: number;
  query: string;
  radiusMeters: number;
}): Promise<NativePlace[]> {
  if (iteratePlaceSearch === null) {
    throw new Error("Nearby place search requires the Iterate iOS development build.");
  }
  return await iteratePlaceSearch.searchNearby(
    input.query,
    input.latitude,
    input.longitude,
    input.radiusMeters,
  );
}

export type { NativePlace };
