import AVFoundation
import CoreGraphics
import CoreImage
import ImageIO
import UniformTypeIdentifiers

/// All capture/renderer/writer state belongs to this serial queue. Camera
/// frames are discarded by AVFoundation if processing falls behind.
final class FilterCapture: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate,
  AVCaptureAudioDataOutputSampleBufferDelegate
{
  let queue = DispatchQueue(label: "com.iterate.filter-camera", qos: .userInitiated)
  private let session = AVCaptureSession()
  private let videoOutput = AVCaptureVideoDataOutput()
  private let audioOutput = AVCaptureAudioDataOutput()
  private let ci = CIContext(options: [.cacheIntermediates: false])
  private let tracker = FilterFaceTracker()
  private var renderer: FilterRenderer?
  private var pool: CVPixelBufferPool?
  private var lastCompleteFrame: CVPixelBuffer?
  private var runtime = ""
  private var settings = ""
  private var facing = "front"
  private var active = false
  private var configured = false
  private var failure: String?
  private var permissionPending = false
  private var microphone = false
  private var pending: String?
  private var pendingTimeout: DispatchWorkItem?
  private var commandSequence = -1
  private var generation = 0
  private var movie: FilterMovieWriter?
  private var finishing: FilterMovieWriter?
  private var startedAt = 0.0
  private var lastTime = 0.0
  private var lastStatus = 0.0
  private var lastTracking = -1.0
  private var face: [String: Any]?
  private var pitch: Double?
  private var pitchTracker = FilterPitch()
  private var wantsPitch = false
  private var width = 720
  private var height = 1280
  private var droppedFrames = 0
  private var observers: [NSObjectProtocol] = []
  var preview: (CVPixelBuffer, CMTime) -> Void = { _, _ in }
  var event: (String, [String: Any]) -> Void = { _, _ in }

  override init() {
    super.init()
    observers = [
      NotificationCenter.default.addObserver(
        forName: .AVCaptureSessionWasInterrupted, object: session, queue: nil
      ) { [weak self] _ in
        self?.queue.async { [weak self] in
          self?.fail("Camera interrupted. Reopen the camera to continue.")
        }
      },
      NotificationCenter.default.addObserver(
        forName: .AVCaptureSessionRuntimeError, object: session, queue: nil
      ) { [weak self] note in
        let message =
          (note.userInfo?[AVCaptureSessionErrorKey] as? Error)?.localizedDescription
          ?? "Camera session failed"
        self?.queue.async { [weak self] in self?.fail(message) }
      },
    ]
  }
  deinit {
    observers.forEach(NotificationCenter.default.removeObserver)
    let session = session
    let movie = movie
    let finishing = finishing
    queue.async {
      session.stopRunning()
      movie?.cancel()
      finishing?.cancel()
    }
  }

  func update(runtime: String, settings: String, facing: String, width: Int, height: Int) {
    queue.async { [weak self] in
      guard let self else { return }
      do {
        if self.runtime != runtime {
          self.renderer = try FilterRenderer(source: runtime, queue: self.queue)
          self.runtime = runtime
          self.renderer?.drawing.tone = { [weak self] hz, ms in
            self?.playTone(hz: hz, durationMs: ms)
          }
          self.settings = ""
        }
        if self.settings != settings {
          // Remember the attempted selection even if its filter throws. Going
          // back to the previous good filter must configure it and clear failure.
          self.settings = settings
          try self.renderer?.configure(settings)
          self.failure = nil
          let values = try JSONSerialization.jsonObject(with: Data(settings.utf8)) as? [String: Any]
          let filterID = values?["filterId"] as? String ?? ""
          self.wantsPitch = filterID == "sing" || filterID.hasPrefix("project:")
        }
        if self.movie == nil && self.finishing == nil
          && (self.width != width || self.height != height)
        {
          self.width = width
          self.height = height
          self.pool = nil
          self.lastCompleteFrame = nil
          self.face = nil
          self.lastTracking = -1
        }
        if self.facing != facing {
          guard self.movie == nil && self.finishing == nil else {
            throw FilterCameraError("Stop recording before switching cameras")
          }
          self.facing = facing
          self.configured = false
          self.face = nil
          self.lastTracking = -1
        }
        if self.active && self.failure == nil { try self.start() }
      } catch { self.fail(error.localizedDescription) }
    }
  }

  func setActive(_ value: Bool) {
    // Hold ownership until teardown has stopped capture and released audio.
    queue.async { [self] in
      self.active = value
      if !value {
        self.pitchTracker = FilterPitch()
        self.pitch = nil
      }
      if value {
        do { try self.start() } catch { self.fail(error.localizedDescription) }
      } else {
        self.generation += 1
        self.pendingTimeout?.cancel()
        self.pending = nil
        self.movie?.cancel()
        self.movie = nil
        self.finishing?.cancel()
        self.finishing = nil
        self.session.stopRunning()
        self.renderer = nil
        self.runtime = ""
        self.settings = ""
        self.configured = false
        self.pool = nil
        self.lastCompleteFrame = nil
        self.failure = nil
        self.face = nil
        self.lastTracking = -1
        self.tonePlayer?.stop()
        self.tonePlayer = nil
        do {
          try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        } catch { NSLog("Filter camera audio teardown failed: %@", error.localizedDescription) }
      }
    }
  }

  private func start() throws {
    guard active, renderer != nil, !permissionPending else { return }
    if AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined {
      permissionPending = true
      AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
        self?.queue.async { [weak self] in
          guard let self else { return }
          self.permissionPending = false
          guard self.active else { return }
          do {
            if !granted { throw FilterCameraError("Camera permission is required") }
            try self.start()
          } catch { self.fail(error.localizedDescription) }
        }
      }
      return
    }
    guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
      throw FilterCameraError("Allow camera access in Settings")
    }
    if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
      permissionPending = true
      AVCaptureDevice.requestAccess(for: .audio) { [weak self] _ in
        self?.queue.async { [weak self] in
          guard let self else { return }
          self.permissionPending = false
          guard self.active else { return }
          do { try self.start() } catch { self.fail(error.localizedDescription) }
        }
      }
      return
    }
    if !configured {
      session.beginConfiguration()
      defer { session.commitConfiguration() }
      session.sessionPreset = .hd1280x720
      for input in session.inputs { session.removeInput(input) }
      for output in session.outputs { session.removeOutput(output) }
      guard
        let device = AVCaptureDevice.default(
          .builtInWideAngleCamera, for: .video, position: facing == "front" ? .front : .back)
      else { throw FilterCameraError("Requested camera is unavailable") }
      let input = try AVCaptureDeviceInput(device: device)
      guard session.canAddInput(input) else { throw FilterCameraError("Could not open camera") }
      session.addInput(input)
      try device.lockForConfiguration()
      if device.activeFormat.videoSupportedFrameRateRanges.contains(where: {
        $0.minFrameRate <= 30 && $0.maxFrameRate >= 30
      }) {
        device.activeVideoMinFrameDuration = CMTime(value: 1, timescale: 30)
        device.activeVideoMaxFrameDuration = CMTime(value: 1, timescale: 30)
      }
      device.unlockForConfiguration()
      videoOutput.videoSettings = [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
      ]
      videoOutput.alwaysDiscardsLateVideoFrames = true
      videoOutput.setSampleBufferDelegate(self, queue: queue)
      guard session.canAddOutput(videoOutput) else {
        throw FilterCameraError("Could not create camera output")
      }
      session.addOutput(videoOutput)
      if let connection = videoOutput.connection(with: .video) {
        if connection.isVideoOrientationSupported { connection.videoOrientation = .portrait }
        if connection.isVideoMirroringSupported {
          connection.automaticallyAdjustsVideoMirroring = false
          connection.isVideoMirrored = facing == "front"
        }
      }
      microphone = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
      if microphone {
        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(
          .playAndRecord, mode: .videoRecording, options: [.defaultToSpeaker, .allowBluetooth])
        try audioSession.setActive(true)
        session.automaticallyConfiguresApplicationAudioSession = false
        guard let mic = AVCaptureDevice.default(for: .audio) else {
          throw FilterCameraError("Microphone is unavailable")
        }
        let audio = try AVCaptureDeviceInput(device: mic)
        guard session.canAddInput(audio), session.canAddOutput(audioOutput) else {
          throw FilterCameraError("Could not open microphone")
        }
        session.addInput(audio)
        session.addOutput(audioOutput)
        audioOutput.setSampleBufferDelegate(self, queue: queue)
      }
      configured = true
    }
    if !session.isRunning { session.startRunning() }
  }

  func retryAssets() {
    queue.async { [weak self] in
      guard let self else { return }
      self.renderer?.assets.retry()
      if self.failure != nil {
        self.failure = nil
        do {
          try self.renderer?.configure(self.settings)
          self.session.stopRunning()
          self.configured = false
          try self.start()
        } catch { self.fail(error.localizedDescription) }
      }
    }
  }

  func command(_ type: String, sequence: Int) {
    queue.async { [weak self] in
      guard let self, sequence != self.commandSequence else { return }
      self.commandSequence = sequence
      if let failure = self.failure {
        self.emit("error", ["message": failure])
        return
      }
      if type == "stop-recording" {
        if self.pending == "start-recording" {
          self.pending = nil
          self.pendingTimeout?.cancel()
          self.emit("error", ["message": "Recording canceled while the camera was loading"])
          return
        }
        self.stopRecording()
        return
      }
      guard self.pending == nil, self.movie == nil, self.finishing == nil else {
        self.emit("error", ["message": "A capture is already in progress"])
        return
      }
      guard type == "snap" || type == "start-recording" else {
        self.fail("Unknown capture command")
        return
      }
      self.pending = type
      let timeout = DispatchWorkItem { [weak self] in
        guard let self, self.pending != nil else { return }
        self.fail("Camera or filter assets did not become ready within 30 seconds")
      }
      self.pendingTimeout = timeout
      self.queue.asyncAfter(deadline: .now() + 30, execute: timeout)
    }
  }

  func captureOutput(
    _ output: AVCaptureOutput, didOutput sample: CMSampleBuffer,
    from connection: AVCaptureConnection
  ) {
    autoreleasepool { process(output, sample: sample) }
  }

  private func process(_ output: AVCaptureOutput, sample: CMSampleBuffer) {
    guard active, failure == nil, let renderer else { return }
    do {
      if output === audioOutput {
        if wantsPitch { pitch = try pitchTracker.append(sample) } else { pitch = nil }
        try movie?.appendAudio(sample)
        return
      }
      guard let input = CMSampleBufferGetImageBuffer(sample) else {
        throw FilterCameraError("Camera frame has no pixels")
      }
      let time = CMSampleBufferGetPresentationTimeStamp(sample)
      lastTime = time.seconds
      let image = CIImage(cvPixelBuffer: input)
      let scale = max(CGFloat(width) / image.extent.width, CGFloat(height) / image.extent.height)
      let transformed = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        .transformed(
          by: CGAffineTransform(
            translationX: (CGFloat(width) - image.extent.width * scale) / 2,
            y: (CGFloat(height) - image.extent.height * scale) / 2))
      guard
        let frame = ci.createCGImage(
          transformed, from: CGRect(x: 0, y: 0, width: width, height: height))
      else { throw FilterCameraError("Could not read camera frame") }
      if time.seconds - lastTracking >= 1.0 / 15 || lastTracking < 0 {
        face = try tracker.detect(frame)
        lastTracking = time.seconds
      }
      if pool == nil {
        guard
          CVPixelBufferPoolCreate(
            nil, [kCVPixelBufferPoolMinimumBufferCountKey: 3] as CFDictionary,
            [
              kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
              kCVPixelBufferWidthKey: width, kCVPixelBufferHeightKey: height,
              kCVPixelBufferIOSurfacePropertiesKey: [:],
            ] as CFDictionary, &pool) == kCVReturnSuccess
        else { throw FilterCameraError("Could not allocate camera buffers") }
      }
      var rendered: CVPixelBuffer?
      let allocation = CVPixelBufferPoolCreatePixelBufferWithAuxAttributes(
        nil, pool!, [kCVPixelBufferPoolAllocationThresholdKey: 4] as CFDictionary, &rendered)
      if allocation == kCVReturnWouldExceedAllocationThreshold {
        droppedFrames += 1
        return
      }
      guard allocation == kCVReturnSuccess, let rendered else {
        throw FilterCameraError("Could not allocate a rendered frame")
      }
      CVPixelBufferLockBaseAddress(rendered, [])
      defer { CVPixelBufferUnlockBaseAddress(rendered, []) }
      guard
        let context = CGContext(
          data: CVPixelBufferGetBaseAddress(rendered), width: width, height: height,
          bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(rendered),
          space: CGColorSpaceCreateDeviceRGB(),
          bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue
            | CGBitmapInfo.byteOrder32Little.rawValue)
      else { throw FilterCameraError("Could not draw camera frame") }
      let status = try renderer.render(
        frame: frame, into: context, timeMs: time.seconds * 1000, pitchHz: pitch, face: face)
      if time.seconds - lastStatus > 0.1 {
        emit(
          "status",
          status.merging(renderer.controls, uniquingKeysWith: { _, new in new }).merging(
            [
              "ready": true, "width": width, "height": height, "microphone": microphone,
              "recording": movie != nil || finishing != nil,
            ], uniquingKeysWith: { _, new in new }))
        lastStatus = time.seconds
      }
      if let error = status["error"] as? String {
        if pending != nil || movie != nil { fail(error) }
        return
      }
      if (status["loading"] as? Bool) == true {
        // Keep the last complete effect visible (with the RN loading spinner)
        // while a newly selected image downloads. Audio/video timestamps stay
        // continuous and memory stays bounded to one retained output frame.
        if let lastCompleteFrame {
          preview(lastCompleteFrame, time)
          try movie?.appendVideo(lastCompleteFrame, at: time)
        } else {
          preview(rendered, time)
        }
        return
      }
      lastCompleteFrame = rendered
      preview(rendered, time)
      if let command = pending {
        pending = nil
        pendingTimeout?.cancel()
        if command == "snap" {
          guard let image = context.makeImage() else {
            throw FilterCameraError("Could not capture photo")
          }
          let url = FileManager.default.temporaryDirectory.appendingPathComponent(
            "filter-\(UUID().uuidString).jpg")
          guard
            let destination = CGImageDestinationCreateWithURL(
              url as CFURL, UTType.jpeg.identifier as CFString, 1, nil)
          else { throw FilterCameraError("Could not create photo file") }
          CGImageDestinationAddImage(
            destination, image, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
          guard CGImageDestinationFinalize(destination) else {
            try? FileManager.default.removeItem(at: url)
            throw FilterCameraError("Could not save photo")
          }
          emit("photo", ["uri": url.absoluteString, "width": width, "height": height])
        } else {
          guard microphone else {
            throw FilterCameraError("Allow microphone access and reopen the camera to record video")
          }
          let url = FileManager.default.temporaryDirectory.appendingPathComponent(
            "filter-\(UUID().uuidString).mp4")
          movie = try FilterMovieWriter(url: url, width: width, height: height, hasAudio: true)
          startedAt = time.seconds
          droppedFrames = 0
          emit("status", ["recording": true])
        }
      }
      try movie?.appendVideo(rendered, at: time)
    } catch { fail(error.localizedDescription) }
  }

  private func stopRecording() {
    // Repeated Stop while the encoder flushes must not reject the clip awaiting delivery.
    guard finishing == nil else { return }
    guard let movie else {
      emit("error", ["message": "No recording is active"])
      return
    }
    self.movie = nil
    finishing = movie
    let generation = generation
    let duration = lastTime - startedAt
    let dropped = droppedFrames
    let width = width
    let height = height
    movie.finish { [weak self] result in
      guard let self else {
        movie.cancel()
        return
      }
      self.queue.async { [weak self] in
        guard let self, self.active, self.generation == generation else {
          movie.cancel()
          return
        }
        self.finishing = nil
        switch result {
        case .success:
          self.emit(
            "video",
            [
              "uri": movie.url.absoluteString, "mimeType": "video/mp4", "durationSeconds": duration,
              "width": width, "height": height, "droppedFrames": dropped + movie.droppedFrames,
            ])
          self.emit("status", ["recording": false])
        case .failure(let error):
          movie.cancel()
          self.fail(error.localizedDescription)
        }
      }
    }
  }

  private func fail(_ message: String) {
    generation += 1
    pending = nil
    pendingTimeout?.cancel()
    movie?.cancel()
    movie = nil
    finishing?.cancel()
    finishing = nil
    failure = message
    emit("error", ["message": message])
    emit("status", ["ready": false, "loading": false, "recording": false, "error": message])
  }

  private func emit(_ type: String, _ data: [String: Any]) {
    DispatchQueue.main.async { [weak self] in self?.event(type, data) }
  }

  private var tonePlayer: AVAudioPlayer?
  private func playTone(hz: Double, durationMs: Double) {
    // A small PCM WAV played by the system; it never enters the video bridge.
    let rate = 48000
    let count = Int(durationMs * 48)
    var bytes = Data()
    func word<T: FixedWidthInteger>(_ value: T) {
      var n = value.littleEndian
      withUnsafeBytes(of: &n) { bytes.append(contentsOf: $0) }
    }
    bytes.append(Data("RIFF".utf8))
    word(UInt32(36 + count * 2))
    bytes.append(Data("WAVEfmt ".utf8))
    word(UInt32(16))
    word(UInt16(1))
    word(UInt16(1))
    word(UInt32(rate))
    word(UInt32(rate * 2))
    word(UInt16(2))
    word(UInt16(16))
    bytes.append(Data("data".utf8))
    word(UInt32(count * 2))
    for i in 0..<count {
      let envelope = min(1, Double(min(i, count - 1 - i)) / 960)
      word(Int16(sin(2 * Double.pi * hz * Double(i) / Double(rate)) * envelope * 10000))
    }
    do {
      let player = try AVAudioPlayer(data: bytes)
      guard player.play() else { throw FilterCameraError("Audio playback is unavailable") }
      tonePlayer = player
      emit("status", ["toneError": NSNull()])
    } catch {
      // Filter sounds are optional feedback; their failure must never discard a recording.
      emit("status", ["toneError": "Could not play filter sound: \(error.localizedDescription)"])
    }
  }

}
