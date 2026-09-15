import AVFoundation
import CoreGraphics
import CoreVideo
import ImageIO

// Run against the production native writer, without a camera or React Native.
@main struct RecordingProof {
  static func main() async throws {
    for frequency in [80.0, 110, 130.81, 261.63, 440, 880] {
      for chunk in [256, 512, 1024, 2048] {
        let detector = FilterPitch()
        var detected: Double?
        for index in 0..<(8192 / chunk) {
          detected = try detector.append(
            tone(
              at: CMTime(value: Int64(index * chunk), timescale: 48000), hz: frequency, count: chunk
            ))
        }
        precondition(
          detected != nil && abs(detected! - frequency) / frequency < 0.02,
          "Pitch \(frequency) Hz in \(chunk)-sample chunks: \(String(describing: detected))")
      }
    }
    try retainedImageAndPathProof()
    try arcWindingProof()
    let frameCount = CommandLine.arguments.contains("--long") ? 3600 : 90
    let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(
      "iterate-native-filter-proof.mp4")
    try? FileManager.default.removeItem(at: url)
    let renderQueue = DispatchQueue(label: "filter-proof")
    let renderer = try FilterRenderer(
      source: String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8), queue: renderQueue)
    var settings: [String: Any] = [
      "filterId": "project:proof",
      "dynamicFilters": [
        [
          "id": "project:proof",
          "source":
            "({ label: 'Proof', emoji: '🎥', draw(args) { this.count = (this.count || 0) + 1; args.ctx.fillStyle = '#00cc00'; args.ctx.fillRect(0, 0, args.width, args.height); args.helpers.emoji('🥔', 50, 50, 60, 0); } })",
        ]
      ],
      "backgroundIndex": 0, "modeIndex": 0, "modeIndex2": 0, "action": NSNull(), "tap": NSNull(),
      "drag": NSNull(),
      "adjust": ["featureScale": 1, "faceScale": 1],
      "maskStretch": [
        "eyes": ["x": 1, "y": 1], "nose": ["x": 1, "y": 1], "lips": ["x": 1, "y": 1],
      ],
    ]
    try renderQueue.sync {
      try renderer.configure(
        String(data: JSONSerialization.data(withJSONObject: settings), encoding: .utf8)!)
    }
    var invalid = settings
    invalid["dynamicFilters"] = [
      ["id": "project:proof", "source": "({ label: 'Invalid', emoji: 'X', draw: null })"]
    ]
    do {
      try renderQueue.sync {
        try renderer.configure(
          String(data: JSONSerialization.data(withJSONObject: invalid), encoding: .utf8)!)
      }
      preconditionFailure("Invalid project filter metadata must fail visibly")
    } catch { precondition(error.localizedDescription.contains("draw")) }
    // The next user selection must recover, including the previous valid one.
    try renderQueue.sync {
      try renderer.configure(
        String(data: JSONSerialization.data(withJSONObject: settings), encoding: .utf8)!)
    }
    let movie = try FilterMovieWriter(url: url, width: 320, height: 480, hasAudio: true)
    for index in 0..<frameCount {
      var buffer: CVPixelBuffer?
      CVPixelBufferCreate(
        nil, 320, 480, kCVPixelFormatType_32BGRA,
        [
          kCVPixelBufferCGImageCompatibilityKey: true,
          kCVPixelBufferCGBitmapContextCompatibilityKey: true,
        ] as CFDictionary, &buffer)
      let pixel = buffer!
      CVPixelBufferLockBaseAddress(pixel, [])
      let context = CGContext(
        data: CVPixelBufferGetBaseAddress(pixel), width: 320, height: 480, bitsPerComponent: 8,
        bytesPerRow: CVPixelBufferGetBytesPerRow(pixel), space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue
          | CGBitmapInfo.byteOrder32Little.rawValue)!
      context.setFillColor(CGColor(red: 0.8, green: 0.1, blue: 0.2, alpha: 1))
      context.fill(CGRect(x: 0, y: 0, width: 320, height: 480))
      let source = context.makeImage()!
      _ = try renderQueue.sync {
        try renderer.render(
          frame: source, into: context, timeMs: Double(index) * 1000 / 30, pitchHz: nil, face: nil)
      }
      CVPixelBufferUnlockBaseAddress(pixel, [])
      let time = CMTime(value: Int64(index), timescale: 30)
      while !movie.isReadyForVideo { try await Task.sleep(nanoseconds: 1_000_000) }
      try movie.appendVideo(pixel, at: time)
      try movie.appendAudio(tone(at: time))
    }
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      movie.finish { continuation.resume(with: $0) }
    }
    let asset = AVURLAsset(url: url)
    let tracks = try await asset.load(.tracks)
    precondition(tracks.filter { $0.mediaType == .video }.count == 1)
    precondition(tracks.filter { $0.mediaType == .audio }.count == 1)
    let reader = try AVAssetReader(asset: asset)
    let audio = AVAssetReaderTrackOutput(
      track: tracks.first { $0.mediaType == .audio }!,
      outputSettings: [
        AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMIsFloatKey: true,
        AVLinearPCMBitDepthKey: 32,
      ])
    reader.add(audio)
    precondition(reader.startReading())
    var audibleSamples = 0
    while let sample = audio.copyNextSampleBuffer(), let block = CMSampleBufferGetDataBuffer(sample)
    {
      var values = [Float](repeating: 0, count: CMBlockBufferGetDataLength(block) / 4)
      values.withUnsafeMutableBytes { raw in
        precondition(
          CMBlockBufferCopyDataBytes(
            block, atOffset: 0, dataLength: raw.count, destination: raw.baseAddress!) == noErr)
      }
      audibleSamples += values.filter { abs($0) > 0.02 }.count
    }
    precondition(
      reader.status == .completed && audibleSamples > 10000,
      "Saved audio must decode to the recorded tone")
    let duration = try await asset.load(.duration).seconds
    precondition(abs(duration - Double(frameCount) / 30) < 0.2)
    let generator = AVAssetImageGenerator(asset: asset)
    let (image, _) = try await generator.image(at: CMTime(seconds: 1, preferredTimescale: 600))
    precondition(image.width == 320 && image.height == 480)
    var rgba = [UInt8](repeating: 0, count: 4)
    rgba.withUnsafeMutableBytes { bytes in
      let sample = CGContext(
        data: bytes.baseAddress, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
      sample.draw(image, in: CGRect(x: -160, y: -240, width: 320, height: 480))
    }
    precondition(
      rgba[1] > 150 && rgba[0] < 100 && rgba[2] < 100,
      "Saved video must contain the green filter, not the red camera input: \(rgba)")
    precondition(movie.writtenFrames == frameCount && movie.droppedFrames == 0)
    let canceledURL = url.deletingPathExtension().appendingPathExtension("canceled.mp4")
    let canceled = try FilterMovieWriter(url: canceledURL, width: 320, height: 480, hasAudio: false)
    canceled.cancel()
    precondition(!FileManager.default.fileExists(atPath: canceledURL.path))
    // Exercise the actual built-in drawers, including hosted images and
    // scratch-canvas cutouts, on the production JavaScriptCore renderer.
    let input = image
    for filter in ["potato", "eyes-lips", "cat", "flashcards", "sing", "face-drop", "paper-toss"] {
      settings["filterId"] = filter
      try renderQueue.sync {
        try renderer.configure(
          String(data: JSONSerialization.data(withJSONObject: settings), encoding: .utf8)!)
      }
      let deadline = Date().addingTimeInterval(35)
      while true {
        let context = CGContext(
          data: nil, width: 320, height: 480, bitsPerComponent: 8, bytesPerRow: 320 * 4,
          space: CGColorSpaceCreateDeviceRGB(),
          bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue
            | CGBitmapInfo.byteOrder32Little.rawValue)!
        let status = try renderQueue.sync {
          try renderer.render(frame: input, into: context, timeMs: 1000, pitchHz: 440, face: nil)
        }
        precondition(status["error"] is NSNull, "\(filter): \(status)")
        if status["loading"] as? Bool == false {
          let destination = CGImageDestinationCreateWithURL(
            url.deletingLastPathComponent().appendingPathComponent("native-\(filter).png") as CFURL,
            "public.png" as CFString, 1, nil)!
          CGImageDestinationAddImage(destination, context.makeImage()!, nil)
          precondition(CGImageDestinationFinalize(destination))
          print("Native built-in filter: \(filter) rendered with assets ready")
          break
        }
        precondition(Date() < deadline, "\(filter) assets did not load")
        try await Task.sleep(nanoseconds: 20_000_000)
      }
    }
    print(
      "Native MP4 proof: rendered frames + audio decode; duration \(duration)s; cancellation removes file; \(frameCount) frames written without drops. \(url.path)"
    )
  }
}

func tone(at time: CMTime, hz: Double = 440, count: Int = 1600) throws -> CMSampleBuffer {
  let rate = 48000.0
  var samples = (0..<count).map { i in
    Float(sin(2 * Double.pi * hz * (time.seconds + Double(i) / rate)) * 0.2)
  }
  var description = AudioStreamBasicDescription(
    mSampleRate: rate, mFormatID: kAudioFormatLinearPCM,
    mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked, mBytesPerPacket: 4,
    mFramesPerPacket: 1, mBytesPerFrame: 4, mChannelsPerFrame: 1, mBitsPerChannel: 32, mReserved: 0)
  var format: CMAudioFormatDescription?
  precondition(
    CMAudioFormatDescriptionCreate(
      allocator: nil, asbd: &description, layoutSize: 0, layout: nil, magicCookieSize: 0,
      magicCookie: nil, extensions: nil, formatDescriptionOut: &format) == noErr)
  var block: CMBlockBuffer?
  precondition(
    CMBlockBufferCreateWithMemoryBlock(
      allocator: nil, memoryBlock: nil, blockLength: count * 4, blockAllocator: nil,
      customBlockSource: nil, offsetToData: 0, dataLength: count * 4, flags: 0,
      blockBufferOut: &block) == noErr)
  samples.withUnsafeMutableBytes { bytes in
    precondition(
      CMBlockBufferReplaceDataBytes(
        with: bytes.baseAddress!, blockBuffer: block!, offsetIntoDestination: 0,
        dataLength: bytes.count) == noErr)
  }
  var timing = CMSampleTimingInfo(
    duration: CMTime(value: 1, timescale: 48000), presentationTimeStamp: time,
    decodeTimeStamp: .invalid)
  var sample: CMSampleBuffer?
  precondition(
    CMSampleBufferCreateReady(
      allocator: nil, dataBuffer: block, formatDescription: format, sampleCount: count,
      sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleSizeEntryCount: 0,
      sampleSizeArray: nil, sampleBufferOut: &sample) == noErr)
  return sample!
}

// Render public project-filter drawing operations, then inspect their pixels.
// A retained image must remain valid; filling a path must not erase its outline.
func retainedImageAndPathProof() throws {
  let input = CGContext(
    data: nil, width: 32, height: 32, bitsPerComponent: 8, bytesPerRow: 128,
    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  input.setFillColor(CGColor(gray: 1, alpha: 1))
  input.fill(CGRect(x: 0, y: 0, width: 32, height: 32))
  let source = input.makeImage()!
  let data = NSMutableData()
  let destination = CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil)!
  CGImageDestinationAddImage(destination, source, nil)
  precondition(CGImageDestinationFinalize(destination))
  let url = "data:image/png;base64," + (data as Data).base64EncodedString()
  let script = """
    var kept; var NativeFilters = {
      configure() { return {}; },
      frame() {
        kept = kept || drawing.image('retained', '\(url)');
        drawing.draw(1, 'drawImage', [kept.source, 0, 0]);
        drawing.draw(1, 'beginPath', []);
        drawing.draw(1, 'arc', [16, 16, 8, 0, Math.PI*2]);
        drawing.draw(1, 'fillStyle', ['#00ff00']);
        drawing.draw(1, 'fill', []);
        drawing.draw(1, 'strokeStyle', ['#ff0000']);
        drawing.draw(1, 'lineWidth', [4]);
        drawing.draw(1, 'stroke', []);
        return {};
      }
    };
    """
  let queue = DispatchQueue(label: "drawing-proof")
  let renderer = try FilterRenderer(source: script, queue: queue)
  try renderer.configure("{}")
  for index in 0..<2 {
    var pixels = [UInt8](repeating: 0, count: 32 * 32 * 4)
    try pixels.withUnsafeMutableBytes { raw in
      let output = CGContext(
        data: raw.baseAddress, width: 32, height: 32, bitsPerComponent: 8, bytesPerRow: 128,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
      let status = try renderer.render(
        frame: source, into: output, timeMs: Double(index) * 33, pitchHz: nil, face: nil)
      precondition(status["loading"] as? Bool == false && status["error"] is NSNull)
    }
    let border = (16 * 32 + 24) * 4
    precondition(
      pixels[border] > 200 && pixels[border + 1] < 40, "fill→stroke must keep its red outline")
    precondition(pixels[0] == 255, "Retained image must still draw on the second frame")
  }
}

func arcWindingProof() throws {
  let sourceContext = CGContext(
    data: nil, width: 32, height: 32, bitsPerComponent: 8, bytesPerRow: 128,
    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  let source = sourceContext.makeImage()!
  for operation in ["arc", "ellipse"] {
    for counterclockwise in [false, true] {
      let args = operation == "arc" ? "16,16,10,0,Math.PI/2" : "16,16,10,8,0,0,Math.PI/2"
      let script = """
        var NativeFilters = { configure() { return {}; }, frame() {
          drawing.draw(1, 'beginPath', []);
          drawing.draw(1, '\(operation)', [\(args),\(counterclockwise)]);
          drawing.draw(1, 'strokeStyle', ['#ffffff']);
          drawing.draw(1, 'lineWidth', [3]);
          drawing.draw(1, 'stroke', []);
          return {};
        } };
        """
      let renderer = try FilterRenderer(
        source: script, queue: DispatchQueue(label: "winding-proof"))
      try renderer.configure("{}")
      var pixels = [UInt8](repeating: 0, count: 32 * 32 * 4)
      try pixels.withUnsafeMutableBytes { raw in
        let output = CGContext(
          data: raw.baseAddress, width: 32, height: 32, bitsPerComponent: 8, bytesPerRow: 128,
          space: CGColorSpaceCreateDeviceRGB(),
          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        _ = try renderer.render(frame: source, into: output, timeMs: 0, pitchHz: nil, face: nil)
      }
      let lowerY = operation == "arc" ? 23 : 22
      let upperY = operation == "arc" ? 9 : 10
      let lowerRight = pixels[(lowerY * 32 + 23) * 4]
      let upperRight = pixels[(upperY * 32 + 23) * 4]
      precondition(
        counterclockwise
          ? (upperRight > 200 && lowerRight == 0) : (lowerRight > 200 && upperRight == 0),
        "\(operation) counterclockwise=\(counterclockwise) must use top-left canvas coordinates")
    }
  }
}
