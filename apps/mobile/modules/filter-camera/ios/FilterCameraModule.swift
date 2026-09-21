import AVFoundation
import ExpoModulesCore

public class FilterCameraModule: Module {
  public func definition() -> ModuleDefinition {
    Name("IterateFilterCamera")
    View(FilterCameraView.self) {
      Events("onStatus", "onPhoto", "onVideo", "onCaptureError")
      Prop("runtime") { (view: FilterCameraView, value: String) in
        view.runtime = value
        view.update()
      }
      Prop("settings") { (view: FilterCameraView, value: String) in
        view.settings = value
        view.update()
      }
      Prop("facing") { (view: FilterCameraView, value: String) in
        view.facing = value
        view.update()
      }
      Prop("retryToken") { (view: FilterCameraView, _: Int) in view.capture.retryAssets() }
      Prop("command") { (view: FilterCameraView, value: [String: Any]?) in
        if let value, let type = value["type"] as? String, let sequence = value["seq"] as? Int {
          view.capture.command(type, sequence: sequence)
        }
      }
    }
  }
}

final class FilterCameraView: ExpoView {
  let capture = FilterCapture()
  let onStatus = EventDispatcher()
  let onPhoto = EventDispatcher()
  let onVideo = EventDispatcher()
  let onCaptureError = EventDispatcher()
  var runtime = "", settings = "", facing = "front"
  private let display = AVSampleBufferDisplayLayer()
  private let previewLock = NSLock()
  private var previewPending = false

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    display.videoGravity = .resizeAspectFill
    layer.addSublayer(display)
    capture.event = { [weak self] type, data in
      guard let self else { return }
      switch type {
      case "status": self.onStatus(data)
      case "photo": self.onPhoto(data)
      case "video": self.onVideo(data)
      default: self.onCaptureError(data)
      }
    }
    capture.preview = { [weak self] buffer, time in
      guard let self else { return }
      self.previewLock.lock()
      if self.previewPending {
        self.previewLock.unlock()
        return
      }
      self.previewPending = true
      self.previewLock.unlock()
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        defer {
          self.previewLock.lock()
          self.previewPending = false
          self.previewLock.unlock()
        }
        if self.display.status == .failed { self.display.flush() }
        guard self.display.isReadyForMoreMediaData else { return }
        var format: CMVideoFormatDescription?
        guard
          CMVideoFormatDescriptionCreateForImageBuffer(
            allocator: nil, imageBuffer: buffer, formatDescriptionOut: &format) == noErr
        else { return }
        var timing = CMSampleTimingInfo(
          duration: .invalid, presentationTimeStamp: time, decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        guard
          CMSampleBufferCreateReadyWithImageBuffer(
            allocator: nil, imageBuffer: buffer, formatDescription: format!, sampleTiming: &timing,
            sampleBufferOut: &sample) == noErr, let sample
        else { return }
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(
          sample, createIfNecessary: true)
        {
          // This is a per-sample flag, not an attachment on the whole buffer.
          let first = unsafeBitCast(
            CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
          CFDictionarySetValue(
            first, Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
            Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
        }
        self.display.enqueue(sample)
      }
    }
  }
  override func layoutSubviews() {
    super.layoutSubviews()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    display.frame = bounds
    CATransaction.commit()
    update()
  }
  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil { update() }
    capture.setActive(window != nil)
  }
  func update() {
    guard !runtime.isEmpty, !settings.isEmpty, bounds.width > 0 else { return }
    let height = min(2048, max(2, Int(720 * bounds.height / bounds.width) / 2 * 2))
    capture.update(runtime: runtime, settings: settings, facing: facing, width: 720, height: height)
  }
}
