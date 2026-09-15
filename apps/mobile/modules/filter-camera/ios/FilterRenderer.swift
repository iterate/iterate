import CoreGraphics
import Foundation
import ImageIO
import JavaScriptCore
import Vision

/// JavaScript owns filter/game logic; CoreGraphics owns pixels. This context
/// lives exclusively on the capture queue, separate from React Native's UI.
final class FilterRenderer {
  private let script: JSContext
  let drawing = FilterDrawing()
  let assets: FilterImages
  private(set) var controls: [String: Any] = [:]

  init(source: String, queue: DispatchQueue) throws {
    guard let script = JSContext() else {
      throw FilterCameraError("Cannot create the filter JavaScript engine")
    }
    self.script = script
    self.assets = FilterImages(queue: queue)
    drawing.script = script
    drawing.loadImage = { [weak assets] key, url in assets?.image(key: key, url: url) }
    script.setObject(drawing, forKeyedSubscript: "drawing" as NSString)
    script.evaluateScript(source)
    try checkError()
    guard script.objectForKeyedSubscript("NativeFilters")?.isObject == true else {
      throw FilterCameraError("Filter engine did not load")
    }
  }

  func configure(_ settings: String) throws {
    guard let data = settings.data(using: .utf8),
      let value = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { throw FilterCameraError("Invalid filter settings") }
    script.exception = nil
    let result = script.objectForKeyedSubscript("NativeFilters")?.invokeMethod(
      "configure", withArguments: [value])
    try checkError()
    guard let controls = result?.toDictionary() as? [String: Any] else {
      throw FilterCameraError("Invalid filter controls")
    }
    self.controls = controls
  }

  func render(
    frame: CGImage, into context: CGContext, timeMs: Double, pitchHz: Double?, face: [String: Any]?
  ) throws -> [String: Any] {
    assets.beginFrame()
    drawing.beginFrame(frame, context: context)
    script.exception = nil
    let result = script.objectForKeyedSubscript("NativeFilters")?.invokeMethod(
      "frame",
      withArguments: [
        [
          "width": context.width, "height": context.height, "timeMs": timeMs,
          "pitchHz": pitchHz as Any? ?? NSNull(), "face": face as Any? ?? NSNull(),
        ]
      ])
    defer { assets.endFrame() }
    try checkError()
    var status = result?.toDictionary() as? [String: Any] ?? [:]
    status["loading"] = assets.isLoading
    status["error"] = assets.error as Any? ?? NSNull()
    return status
  }

  private func checkError() throws {
    if let exception = script.exception {
      let message = exception.toString() ?? "Filter failed"
      script.exception = nil
      throw FilterCameraError(message)
    }
  }
}

/// The system tracker returns named rings in normalized top-left coordinates.
/// It sees the same cropped/mirrored image the renderer sees.
final class FilterFaceTracker {
  private let request = VNDetectFaceLandmarksRequest()
  func detect(_ image: CGImage) throws -> [String: Any]? {
    try VNImageRequestHandler(cgImage: image, orientation: .up).perform([request])
    guard let face = request.results?.max(by: { $0.boundingBox.width < $1.boundingBox.width }),
      let landmarks = face.landmarks,
      let a = landmarks.leftEye, let b = landmarks.rightEye, let nose = landmarks.nose,
      let lips = landmarks.outerLips,
      a.pointCount > 2, b.pointCount > 2, nose.pointCount > 2, lips.pointCount > 2
    else { return nil }
    let box = face.boundingBox
    func ring(_ region: VNFaceLandmarkRegion2D) -> [[String: Double]] {
      region.normalizedPoints.map {
        [
          "x": Double(box.minX + CGFloat($0.x) * box.width),
          "y": Double(1 - box.minY - CGFloat($0.y) * box.height),
        ]
      }
    }
    return [
      "box": ["cx": box.midX, "cy": 1 - box.midY, "width": box.width, "height": box.height],
      "eyeA": ring(a), "eyeB": ring(b), "nose": ring(nose), "lips": ring(lips),
    ]
  }
}

/// Decode a bounded set of images, downloading to files rather than collecting
/// response bodies in memory. Only errors for this frame's assets affect it.
final class FilterImages {
  private let queue: DispatchQueue
  private let session: URLSession
  private let cache = NSCache<NSString, CGImage>()
  private struct Download {
    let id: UUID
    let task: URLSessionDownloadTask
  }
  private var tasks: [String: Download] = [:]
  private var failures: [String: String] = [:]
  private var used = Set<String>()

  init(queue: DispatchQueue) {
    self.queue = queue
    let configuration = URLSessionConfiguration.default
    configuration.timeoutIntervalForRequest = 30
    configuration.timeoutIntervalForResource = 30
    configuration.httpMaximumConnectionsPerHost = 4
    session = URLSession(configuration: configuration)
    cache.countLimit = 12
    cache.totalCostLimit = 32 * 1024 * 1024
  }
  deinit { session.invalidateAndCancel() }
  func beginFrame() { used.removeAll(keepingCapacity: true) }
  var isLoading: Bool {
    used.contains { cache.object(forKey: $0 as NSString) == nil && failures[$0] == nil }
  }
  var error: String? { used.compactMap { failures[$0] }.first }
  func retry() { failures.removeAll() }
  func endFrame() {
    for (url, download) in tasks where !used.contains(url) {
      download.task.cancel()
      tasks.removeValue(forKey: url)
    }
    failures = failures.filter { used.contains($0.key) }
  }

  func image(key: String, url: String) -> CGImage? {
    used.insert(url)
    guard used.count <= 8 else {
      failures[url] = "A filter may draw at most eight distinct images per frame"
      return nil
    }
    if let image = cache.object(forKey: url as NSString) { return image }
    if tasks[url] != nil || failures[url] != nil { return nil }
    guard let location = URL(string: url), ["https", "data"].contains(location.scheme) else {
      failures[url] = "Image \(key) needs an HTTPS or data URL"
      return nil
    }
    if location.scheme == "data" {
      do {
        guard url.utf8.count < 8 * 1024 * 1024, let separator = url.firstIndex(of: ","),
          url[..<separator].hasSuffix(";base64"),
          let data = Data(base64Encoded: String(url[url.index(after: separator)...])),
          let source = CGImageSourceCreateWithData(data as CFData, nil)
        else { throw FilterCameraError("Invalid image data") }
        let image = try Self.decode(source)
        cache.setObject(image, forKey: url as NSString, cost: image.bytesPerRow * image.height)
        return image
      } catch {
        failures[url] = "Image \(key): \(error.localizedDescription)"
        return nil
      }
    }
    guard tasks.count < 4 else { return nil }
    let id = UUID()
    let task = session.downloadTask(with: location) { [weak self] file, response, error in
      guard let self else { return }
      let result: Result<CGImage, Error>
      do {
        if let error { throw error }
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
          throw FilterCameraError(
            "Download returned HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)")
        }
        guard let file, let source = CGImageSourceCreateWithURL(file as CFURL, nil) else {
          throw FilterCameraError("Downloaded file is not an image")
        }
        result = .success(try Self.decode(source))
      } catch { result = .failure(error) }
      self.queue.async {
        guard self.tasks[url]?.id == id else { return }
        self.tasks.removeValue(forKey: url)
        switch result {
        case .success(let image):
          self.cache.setObject(
            image, forKey: url as NSString, cost: image.bytesPerRow * image.height)
        case .failure(let error): self.failures[url] = "Image \(key): \(error.localizedDescription)"
        }
      }
    }
    tasks[url] = Download(id: id, task: task)
    task.resume()
    return nil
  }
  private static func decode(_ source: CGImageSource) throws -> CGImage {
    guard
      let image = CGImageSourceCreateThumbnailAtIndex(
        source, 0,
        [
          kCGImageSourceCreateThumbnailFromImageAlways: true,
          kCGImageSourceCreateThumbnailWithTransform: true,
          kCGImageSourceThumbnailMaxPixelSize: 1024, kCGImageSourceShouldCacheImmediately: true,
        ] as CFDictionary)
    else { throw FilterCameraError("Could not decode image") }
    return image
  }
}
