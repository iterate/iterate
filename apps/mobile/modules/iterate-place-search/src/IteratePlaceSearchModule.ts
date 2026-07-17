import { NativeModule, requireOptionalNativeModule } from "expo";

export type NativePlace = {
  id: string;
  latitude: number;
  longitude: number;
  name: string;
};

declare class IteratePlaceSearchModule extends NativeModule {
  searchNearby(
    query: string,
    latitude: number,
    longitude: number,
    radiusMeters: number,
  ): Promise<NativePlace[]>;
}

export const iteratePlaceSearch =
  requireOptionalNativeModule<IteratePlaceSearchModule>("IteratePlaceSearch");
