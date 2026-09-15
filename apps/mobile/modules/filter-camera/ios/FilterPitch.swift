import AVFoundation

/// A bounded microphone window, independent of AVFoundation callback size.
/// Accessed only by the capture queue; analysis is capped at 15 times/second.
final class FilterPitch {
  private var samples = [Double](repeating: 0, count: 2048)
  private var cursor = 0
  private var count = 0
  private var sampleRate = 0.0
  private var lastAnalysis = -Double.infinity
  private var frequency: Double?

  func append(_ sample: CMSampleBuffer) throws -> Double? {
    guard let format = CMSampleBufferGetFormatDescription(sample),
      let stream = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee,
      let block = CMSampleBufferGetDataBuffer(sample), stream.mFormatID == kAudioFormatLinearPCM
    else { throw FilterCameraError("Microphone did not provide PCM samples for singing") }
    let stride =
      stream.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
      ? 1 : Int(stream.mChannelsPerFrame)
    let bytesPerSample = Int(stream.mBitsPerChannel / 8)
    let isFloat = stream.mFormatFlags & kAudioFormatFlagIsFloat != 0 && stream.mBitsPerChannel == 32
    let isSigned16 =
      stream.mFormatFlags & kAudioFormatFlagIsSignedInteger != 0 && stream.mBitsPerChannel == 16
    guard stride > 0, bytesPerSample > 0, stream.mSampleRate > 0,
      stream.mFormatFlags & kAudioFormatFlagIsBigEndian == 0, isFloat || isSigned16
    else { throw FilterCameraError("Unsupported microphone sample format for singing") }
    let available = min(
      CMSampleBufferGetNumSamples(sample),
      CMBlockBufferGetDataLength(block) / bytesPerSample / stride)
    let incoming = min(available, samples.count)
    let offset = (available - incoming) * bytesPerSample * stride
    var bytes = [UInt8](repeating: 0, count: incoming * bytesPerSample * stride)
    guard
      CMBlockBufferCopyDataBytes(
        block, atOffset: offset, dataLength: bytes.count, destination: &bytes) == noErr
    else { throw FilterCameraError("Could not read microphone samples") }
    if sampleRate != stream.mSampleRate {
      sampleRate = stream.mSampleRate
      count = 0
      cursor = 0
      frequency = nil
      lastAnalysis = -.infinity
    }
    bytes.withUnsafeBytes { raw in
      for i in 0..<incoming {
        let value =
          isFloat
          ? Double(raw.loadUnaligned(fromByteOffset: i * stride * 4, as: Float.self))
          : Double(raw.loadUnaligned(fromByteOffset: i * stride * 2, as: Int16.self)) / 32768
        samples[cursor] = value
        cursor = (cursor + 1) % samples.count
        count = min(count + 1, samples.count)
      }
    }
    let time = CMSampleBufferGetPresentationTimeStamp(sample).seconds
    guard count == samples.count else { return nil }
    if time - lastAnalysis < 1.0 / 15 { return frequency }
    lastAnalysis = time
    let values = Array(samples[cursor...]) + Array(samples[..<cursor])
    frequency = Self.detect(values, rate: sampleRate)
    return frequency
  }

  private static func detect(_ values: [Double], rate: Double) -> Double? {
    let energy = values.reduce(0) { $0 + $1 * $1 }
    guard energy / Double(values.count) > 0.000144 else { return nil }
    let minimum = max(2, Int(rate / 1000))
    let maximum = min(values.count / 2, Int(rate / 70))
    guard maximum > minimum else { return nil }
    var best = 0
    var strength = 0.0
    for lag in minimum...maximum {
      var cross = 0.0
      var pairEnergy = 0.0
      for i in 0..<(values.count - lag) {
        cross += values[i] * values[i + lag]
        pairEnergy += values[i] * values[i] + values[i + lag] * values[i + lag]
      }
      let score = pairEnergy > 0 ? 2 * cross / pairEnergy : 0
      if score > strength {
        strength = score
        best = lag
      }
      // First strong peak is the period; later peaks are its multiples.
      if strength > 0.95 && score < strength - 0.01 { break }
    }
    return strength > 0.8 && best > 0 ? rate / Double(best) : nil
  }
}
