import ExpoModulesCore
import Foundation
import MapKit

public class IteratePlaceSearchModule: Module {
  public func definition() -> ModuleDefinition {
    Name("IteratePlaceSearch")

    AsyncFunction("searchNearby") {
      (query: String, latitude: Double, longitude: Double, radiusMeters: Double, promise: Promise) in
      let request = MKLocalSearch.Request()
      request.naturalLanguageQuery = query
      request.pointOfInterestFilter = MKPointOfInterestFilter.includingAll
      request.region = MKCoordinateRegion(
        center: CLLocationCoordinate2D(latitude: latitude, longitude: longitude),
        latitudinalMeters: radiusMeters * 2,
        longitudinalMeters: radiusMeters * 2
      )

      MKLocalSearch(request: request).start { response, error in
        if let error {
          promise.reject("ERR_PLACE_SEARCH_FAILED", error.localizedDescription)
          return
        }
        guard let response else {
          promise.reject("ERR_PLACE_SEARCH_EMPTY_RESPONSE", "MapKit returned no response.")
          return
        }

        promise.resolve(response.mapItems.map { item in
          let coordinate = item.placemark.coordinate
          return [
            "id": String(format: "%.6f,%.6f", coordinate.latitude, coordinate.longitude),
            "name": item.name ?? query,
            "latitude": coordinate.latitude,
            "longitude": coordinate.longitude,
          ] as [String: Any]
        })
      }
    }.runOnQueue(.main)
  }
}
