import CoreGraphics
import CoreText
import ImageIO
import JavaScriptCore

@objc protocol FilterDrawingAPI: JSExport {
  func createCanvas() -> Int
  func resize(_ id: Int, _ width: Int, _ height: Int)
  func draw(_ id: Int, _ operation: String, _ arguments: [Any])
  func image(_ key: String, _ url: String) -> [String: Any]?
  func playTone(_ hz: Double, _ durationMs: Double)
}

/// A deliberately small drawing API, not a browser or HTML canvas emulation.
/// Shared filter helpers use these operations on both platforms.
final class FilterDrawing: NSObject, FilterDrawingAPI {
  var surfaces: [Int: FilterSurface] = [:]
  var frame: CGImage?
  weak var script: JSContext?
  var loadImage: (String, String) -> CGImage? = { _, _ in nil }
  var tone: (Double, Double) -> Void = { _, _ in }
  var usedImages: [String: CGImage] = [:]
  private var nextID = 2
  private var operations = 0

  func beginFrame(_ image: CGImage, context: CGContext) {
    frame = image
    surfaces[1] = FilterSurface(context: context)
    usedImages.removeAll(keepingCapacity: true)
    operations = 0
  }

  func createCanvas() -> Int {
    guard nextID < 32 else {
      fail("A filter may own at most 30 scratch canvases")
      return -1
    }
    let id = nextID
    nextID += 1
    return id
  }

  func resize(_ id: Int, _ width: Int, _ height: Int) {
    guard (2..<32).contains(id), (1...2048).contains(width), (1...2048).contains(height) else {
      fail("Invalid scratch canvas size (maximum 2048×2048)")
      return
    }
    let otherBytes = surfaces.filter { $0.key >= 2 && $0.key != id }.values.reduce(0) {
      $0 + $1.context.bytesPerRow * $1.context.height
    }
    guard otherBytes + width * height * 4 <= 32 * 1024 * 1024 else {
      fail("Filter scratch canvases exceed 32 MB")
      return
    }
    guard
      let context = CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue
          | CGBitmapInfo.byteOrder32Little.rawValue)
    else {
      fail("Could not allocate scratch canvas")
      return
    }
    surfaces[id] = FilterSurface(context: context)
  }

  func image(_ key: String, _ url: String) -> [String: Any]? {
    guard let image = loadImage(key, url) else { return nil }
    usedImages[url] = image
    return ["source": url, "width": image.width, "height": image.height]
  }

  func playTone(_ hz: Double, _ durationMs: Double) {
    guard hz.isFinite, durationMs.isFinite, (20...20000).contains(hz),
      (1...5000).contains(durationMs)
    else {
      fail("Tone frequency/duration is out of range")
      return
    }
    tone(hz, durationMs)
  }

  func draw(_ id: Int, _ operation: String, _ arguments: [Any]) {
    operations += 1
    guard operations < 10000, let surface = surfaces[id] else {
      fail("Invalid canvas or excessive drawing operations")
      return
    }
    if operation == "drawImage", let url = arguments.first as? String, usedImages[url] == nil {
      // Project filters may retain an image handle between frames. Reacquire
      // its pixels from the bounded asset cache, marking it used this frame.
      guard let image = loadImage(url, url) else { return }
      usedImages[url] = image
    }
    do {
      try surface.draw(
        operation, arguments,
        image: { source in
          if let url = source as? String { return self.usedImages[url] }
          guard let number = source as? NSNumber else { return nil }
          return number.intValue == 0
            ? self.frame : self.surfaces[number.intValue]?.context.makeImage()
        })
    } catch { fail(error.localizedDescription) }
  }

  private func fail(_ message: String) {
    if let script { script.exception = JSValue(newErrorFromMessage: message, in: script) }
  }
}

final class FilterSurface {
  let context: CGContext
  private struct TextStyle {
    var font = "10px sans-serif"
    var align = "start"
    var baseline = "alphabetic"
    var fill = CGColor(gray: 0, alpha: 1)
  }
  private var text = TextStyle()
  private var saved: [TextStyle] = []

  init(context: CGContext) {
    self.context = context
    // Filter coordinates have their origin at the top left.
    context.translateBy(x: 0, y: CGFloat(context.height))
    context.scaleBy(x: 1, y: -1)
    context.setFillColor(text.fill)
    context.setStrokeColor(text.fill)
  }

  func draw(_ op: String, _ args: [Any], image: (Any) -> CGImage?) throws {
    let c = context
    func number(_ index: Int) throws -> CGFloat {
      guard index < args.count, let value = args[index] as? NSNumber, value.doubleValue.isFinite
      else { throw FilterCameraError("\(op): expected finite number at \(index)") }
      return CGFloat(value.doubleValue)
    }
    func rect(_ offset: Int = 0) throws -> CGRect {
      try CGRect(
        x: number(offset), y: number(offset + 1), width: number(offset + 2),
        height: number(offset + 3))
    }
    func string() throws -> String {
      guard let value = args.first as? String else {
        throw FilterCameraError("\(op): expected a string")
      }
      return value
    }
    switch op {
    case "save":
      guard saved.count < 64 else { throw FilterCameraError("Too many nested canvas saves") }
      c.saveGState()
      saved.append(text)
    case "restore":
      if let previous = saved.popLast() {
        c.restoreGState()
        text = previous
      }
    case "clearRect": c.clear(try rect())
    case "fillRect": c.fill(try rect())
    case "strokeRect": c.stroke(try rect())
    case "translate": c.translateBy(x: try number(0), y: try number(1))
    case "rotate": c.rotate(by: try number(0))
    case "scale": c.scaleBy(x: try number(0), y: try number(1))
    case "setTransform":
      c.concatenate(c.ctm.inverted())
      c.translateBy(x: 0, y: CGFloat(c.height))
      c.scaleBy(x: 1, y: -1)
      c.concatenate(
        try CGAffineTransform(
          a: number(0), b: number(1), c: number(2), d: number(3), tx: number(4), ty: number(5)))
    case "beginPath": c.beginPath()
    case "closePath": c.closePath()
    case "moveTo": c.move(to: try CGPoint(x: number(0), y: number(1)))
    case "lineTo": c.addLine(to: try CGPoint(x: number(0), y: number(1)))
    // The top-left transform flips CoreGraphics' y axis: increasing angles
    // appear clockwise, matching Canvas when counterclockwise is false.
    case "arc":
      c.addArc(
        center: try CGPoint(x: number(0), y: number(1)), radius: try number(2),
        startAngle: try number(3), endAngle: try number(4),
        clockwise: args.count > 5 && (args[5] as? Bool) == true)
    case "ellipse":
      let x = try number(0)
      let y = try number(1)
      let rx = try number(2)
      let ry = try number(3)
      let angle = try number(4)
      guard rx > 0, ry > 0 else { return }
      let path = CGMutablePath()
      let transform = CGAffineTransform(translationX: x, y: y).rotated(by: angle).scaledBy(
        x: rx, y: ry)
      path.addArc(
        center: .zero, radius: 1, startAngle: try number(5), endAngle: try number(6),
        clockwise: args.count > 7 && (args[7] as? Bool) == true, transform: transform)
      c.addPath(path)
    case "roundRect":
      let r = try rect()
      let radius = min(try number(4), min(abs(r.width), abs(r.height)) / 2)
      c.addPath(CGPath(roundedRect: r, cornerWidth: radius, cornerHeight: radius, transform: nil))
    // CoreGraphics consumes the current path; our drawing contract keeps it
    // so fill→stroke and repeated clips behave like the browser helpers.
    case "fill", "stroke", "clip":
      let path = c.path
      if op == "fill" { c.fillPath() } else if op == "stroke" { c.strokePath() } else { c.clip() }
      if let path { c.addPath(path) }
    case "fillStyle":
      text.fill = try Self.color(string())
      c.setFillColor(text.fill)
    case "strokeStyle": c.setStrokeColor(try Self.color(string()))
    case "lineWidth": c.setLineWidth(try number(0))
    case "globalAlpha": c.setAlpha(try number(0))
    case "globalCompositeOperation":
      let value = try string()
      switch value {
      case "source-over": c.setBlendMode(.normal)
      case "destination-in": c.setBlendMode(.destinationIn)
      case "destination-out": c.setBlendMode(.destinationOut)
      case "copy": c.setBlendMode(.copy)
      default: throw FilterCameraError("Unsupported blend mode: \(value)")
      }
    case "imageSmoothingEnabled":
      c.interpolationQuality = (args.first as? Bool) == false ? .none : .high
    case "font": text.font = try string()
    case "textAlign": text.align = try string()
    case "textBaseline": text.baseline = try string()
    case "fillText":
      let value = try string()
      let x = try number(1)
      let y = try number(2)
      let pattern = try NSRegularExpression(pattern: "([0-9.]+)px")
      let match = pattern.firstMatch(
        in: text.font, range: NSRange(text.font.startIndex..., in: text.font))
      let size =
        match.flatMap { Range($0.range(at: 1), in: text.font) }.flatMap { Double(text.font[$0]) }
        ?? 10
      let emoji = value.unicodeScalars.contains { $0.value >= 0x1F000 }
      let name =
        emoji
        ? "AppleColorEmoji"
        : (text.font.hasPrefix("600") || text.font.hasPrefix("700")
          ? "HelveticaNeue-Bold" : "HelveticaNeue")
      let font = CTFontCreateWithName(name as CFString, size, nil)
      let attrs: [NSAttributedString.Key: Any] = [
        NSAttributedString.Key(kCTFontAttributeName as String): font,
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): text.fill,
      ]
      let line = CTLineCreateWithAttributedString(
        NSAttributedString(string: value, attributes: attrs))
      var ascent: CGFloat = 0
      var descent: CGFloat = 0
      let width = CGFloat(CTLineGetTypographicBounds(line, &ascent, &descent, nil))
      let dx =
        text.align == "center"
        ? -width / 2 : (text.align == "right" || text.align == "end" ? -width : 0)
      let dy =
        text.baseline == "middle"
        ? (ascent - descent) / 2
        : (text.baseline == "top" || text.baseline == "hanging"
          ? ascent : (text.baseline == "bottom" ? -descent : 0))
      c.saveGState()
      c.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
      c.textPosition = CGPoint(x: x + dx, y: y + dy)
      CTLineDraw(line, c)
      c.restoreGState()
    case "drawImage":
      guard let source = args.first, let bitmap = image(source) else {
        throw FilterCameraError("Image handle is no longer available")
      }
      let bounds = CGRect(x: 0, y: 0, width: bitmap.width, height: bitmap.height)
      var src = bounds
      var dst: CGRect
      if args.count == 3 {
        dst = try CGRect(x: number(1), y: number(2), width: bounds.width, height: bounds.height)
      } else if args.count == 5 {
        dst = try rect(1)
      } else if args.count == 9 {
        src = try rect(1)
        dst = try rect(5)
      } else {
        throw FilterCameraError("drawImage needs 2, 4, or 8 coordinates")
      }
      guard src.width > 0, src.height > 0, dst.width > 0, dst.height > 0 else { return }
      let crop = src.intersection(bounds)
      guard !crop.isNull, let cropped = bitmap.cropping(to: crop) else { return }
      let target = CGRect(
        x: dst.minX + (crop.minX - src.minX) * dst.width / src.width,
        y: dst.minY + (crop.minY - src.minY) * dst.height / src.height,
        width: crop.width * dst.width / src.width, height: crop.height * dst.height / src.height)
      c.saveGState()
      c.translateBy(x: target.minX, y: target.maxY)
      c.scaleBy(x: 1, y: -1)
      c.draw(cropped, in: CGRect(origin: .zero, size: target.size))
      c.restoreGState()
    default: throw FilterCameraError("Unsupported drawing operation: \(op)")
    }
  }

  static func color(_ value: String) throws -> CGColor {
    let names = [
      "black": "#000000", "white": "#ffffff", "red": "#ff0000", "green": "#008000",
      "blue": "#0000ff", "yellow": "#ffff00", "transparent": "#00000000",
    ]
    let s = names[value.lowercased()] ?? value
    if s.hasPrefix("#") {
      var hex = String(s.dropFirst())
      if hex.count == 3 || hex.count == 4 { hex = hex.map { "\($0)\($0)" }.joined() }
      guard hex.count == 6 || hex.count == 8, let n = UInt64(hex, radix: 16) else {
        throw FilterCameraError("Invalid color: \(value)")
      }
      if hex.count == 6 {
        return CGColor(
          red: CGFloat((n >> 16) & 255) / 255, green: CGFloat((n >> 8) & 255) / 255,
          blue: CGFloat(n & 255) / 255, alpha: 1)
      }
      return CGColor(
        red: CGFloat((n >> 24) & 255) / 255, green: CGFloat((n >> 16) & 255) / 255,
        blue: CGFloat((n >> 8) & 255) / 255, alpha: CGFloat(n & 255) / 255)
    }
    let parts = s.components(separatedBy: CharacterSet(charactersIn: "(),% ")).filter {
      !$0.isEmpty
    }
    if parts.count >= 4, let x = Double(parts[1]), let y = Double(parts[2]),
      let z = Double(parts[3])
    {
      let alpha = parts.count > 4 ? Double(parts[4]) ?? 1 : 1
      if parts[0] == "rgb" || parts[0] == "rgba" {
        return CGColor(red: x / 255, green: y / 255, blue: z / 255, alpha: alpha)
      }
      if parts[0] == "hsl" || parts[0] == "hsla" {
        let h =
          (x.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360) / 60
        let sat = y / 100
        let light = z / 100
        let chroma = (1 - abs(2 * light - 1)) * sat
        let m = light - chroma / 2
        let a = chroma * (1 - abs(h.truncatingRemainder(dividingBy: 2) - 1))
        let rgb: [Double]
        switch Int(h) {
        case 0: rgb = [chroma, a, 0]
        case 1: rgb = [a, chroma, 0]
        case 2: rgb = [0, chroma, a]
        case 3: rgb = [0, a, chroma]
        case 4: rgb = [a, 0, chroma]
        default: rgb = [chroma, 0, a]
        }
        return CGColor(red: rgb[0] + m, green: rgb[1] + m, blue: rgb[2] + m, alpha: alpha)
      }
    }
    throw FilterCameraError("Unsupported color: \(value). Use hex, rgb(), or hsl().")
  }
}
