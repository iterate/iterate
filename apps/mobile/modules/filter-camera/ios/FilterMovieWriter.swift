import AVFoundation

/// Incremental native recording. Call append/cancel on the camera's serial queue.
/// Only AVAssetWriter owns encoding buffers; the app never queues video frames.
final class FilterMovieWriter {
  let url: URL
  private let writer: AVAssetWriter
  private let video: AVAssetWriterInput
  private let pixels: AVAssetWriterInputPixelBufferAdaptor
  private let audio: AVAssetWriterInput?
  private var startedAt: CMTime?
  private var ended = false
  // finishWriting calls back on the encoder queue; cancel runs on the capture queue.
  private let finishLock = NSLock()
  private var finishing = false
  private var cancelAfterFinish = false
  private(set) var writtenFrames = 0
  private(set) var droppedFrames = 0

  init(url: URL, width: Int, height: Int, hasAudio: Bool) throws {
    self.url = url
    writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
    video = AVAssetWriterInput(
      mediaType: .video,
      outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: width, AVVideoHeightKey: height,
        AVVideoCompressionPropertiesKey: [
          AVVideoAverageBitRateKey: 3_500_000, AVVideoExpectedSourceFrameRateKey: 30,
        ],
      ])
    video.expectsMediaDataInRealTime = true
    pixels = AVAssetWriterInputPixelBufferAdaptor(
      assetWriterInput: video,
      sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height,
      ])
    guard writer.canAdd(video) else { throw FilterCameraError("Cannot create the video encoder") }
    writer.add(video)
    if hasAudio {
      let input = AVAssetWriterInput(
        mediaType: .audio,
        outputSettings: [
          AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48000,
          AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 128000,
        ])
      input.expectsMediaDataInRealTime = true
      guard writer.canAdd(input) else { throw FilterCameraError("Cannot create the audio encoder") }
      writer.add(input)
      audio = input
    } else {
      audio = nil
    }
    guard writer.startWriting() else {
      throw writer.error ?? FilterCameraError("Cannot start recording")
    }
  }

  var isReadyForVideo: Bool { video.isReadyForMoreMediaData }

  func appendVideo(_ buffer: CVPixelBuffer, at time: CMTime) throws {
    guard !ended else { return }
    guard writer.status == .writing else {
      throw writer.error ?? FilterCameraError("Video encoder stopped")
    }
    if startedAt == nil {
      writer.startSession(atSourceTime: time)
      startedAt = time
    }
    // Backpressure drops this frame instead of growing a queue. Report the
    // count with the result so sustained encoder overload is visible.
    guard video.isReadyForMoreMediaData else {
      droppedFrames += 1
      return
    }
    guard pixels.append(buffer, withPresentationTime: time) else {
      throw writer.error ?? FilterCameraError("Could not write a video frame")
    }
    writtenFrames += 1
  }

  func appendAudio(_ sample: CMSampleBuffer) throws {
    guard !ended, let audio, let startedAt,
      CMSampleBufferGetPresentationTimeStamp(sample) >= startedAt
    else { return }
    guard audio.isReadyForMoreMediaData else {
      throw FilterCameraError("The audio encoder could not keep up; recording stopped")
    }
    guard audio.append(sample) else {
      throw writer.error ?? FilterCameraError("Could not write recorded audio")
    }
  }

  /// Begin finishing on the same serial queue as append/cancel. The callback
  /// may run on the encoder queue; the owner returns to its capture queue.
  func finish(completion: @escaping (Result<Void, Error>) -> Void) {
    guard !ended, writtenFrames > 0 else {
      cancel()
      completion(.failure(FilterCameraError("No video frames were recorded")))
      return
    }
    ended = true
    video.markAsFinished()
    audio?.markAsFinished()
    finishLock.withLock { finishing = true }
    writer.finishWriting { [self] in
      let result: Result<Void, Error> = finishLock.withLock {
        finishing = false
        if cancelAfterFinish {
          try? FileManager.default.removeItem(at: url)
          return .failure(FilterCameraError("Recording was canceled"))
        }
        if writer.status == .completed { return .success(()) }
        return .failure(writer.error ?? FilterCameraError("Recording could not finish"))
      }
      completion(result)
    }
  }

  func cancel() {
    ended = true
    finishLock.withLock {
      if finishing {
        // Canceling AVAssetWriter here can suppress its completion callback.
        // Let the encoder finish, then delete the canceled clip before delivery.
        cancelAfterFinish = true
        return
      }
      if writer.status == .writing { writer.cancelWriting() }
      try? FileManager.default.removeItem(at: url)
    }
  }
}

struct FilterCameraError: LocalizedError {
  let errorDescription: String?
  init(_ message: String) { errorDescription = message }
}
