// The 𝑖 menu-bar mark, drawn from the brand logo's own vector paths
// (packages/ui/src/assets/iterate-logo.svg) so there's no asset catalog and
// no rasterization step. The glyph is pure polygons (M/L/H/V/Z, absolute), so
// a tiny path reader turns it straight into an NSBezierPath. Rendered as a
// template image: white on the dark menu bar, adapting on light.

import AppKit

enum IterateIcon {
  /// The two `i` paths from iterate-logo.svg (viewBox 0 0 500 500), verbatim.
  private static let paths = [
    "M264.649 170.149H289.821L286.092 186.904L276.303 233.444L270.709 259.971L263.717 293.015L258.124 320.008L251.131 352.586L249.267 364.687V371.668L249.733 372.133H253.462L259.522 369.806L266.048 365.617L275.371 357.24L282.829 349.328L286.558 345.14L288.888 346.071L294.948 350.725L308 360.498L307.068 362.36L303.339 367.944L296.813 376.322L291.685 382.837L286.558 388.422L282.363 393.076L275.837 399.592L272.108 402.849L267.446 406.573L262.785 409.83L256.725 413.554L247.869 417.742L238.08 420.535L231.554 421H224.096L216.637 420.069L211.51 418.673L206.382 416.811L201.255 413.088L196.594 408.434L192.865 400.988L191.466 394.938L191 389.818V383.768L193.797 365.152L199.857 335.832L207.315 301.392L224.096 223.205L225.028 216.224V206.916L224.562 205.054L222.231 204.123L219.434 203.193L206.382 203.658L196.127 204.589H193.331V178.526L194.263 175.734L258.59 170.615L264.649 170.149Z",
    "M264.649 78H268.844L275.836 78.9308L282.362 80.7924L287.49 83.5848L292.151 87.7734L295.414 92.8928L297.278 96.616L299.143 105.924L299.609 113.836L299.143 118.49L298.677 122.213L296.812 128.729L293.549 134.779L290.286 138.502L286.091 141.76L282.362 143.621L278.167 145.018L274.438 145.948L267.912 146.414H260.92L254.394 145.483L249.267 144.087L244.139 141.294L239.944 138.037L236.681 133.383L233.884 127.332L232.486 121.282L232.02 117.559V108.716L232.952 101.735L234.816 95.6852L237.613 90.1004L240.41 86.3772L246.936 82.1886L252.529 79.8616L259.522 78.4654L264.649 78Z",
  ]

  /// The template 𝑖, sized for the menu bar (~16pt tall, aspect-preserved).
  static let mark: NSImage = render(height: 16)

  private static func render(height: CGFloat) -> NSImage {
    let glyph = NSBezierPath()
    for path in paths { glyph.append(parse(path)) }
    let bounds = glyph.bounds

    let scale = height / bounds.height
    let width = bounds.width * scale
    // Map SVG space (y-down) into the image (y-up): flip Y, then scale.
    var transform = AffineTransform()
    transform.translate(x: -bounds.minX * scale, y: height + bounds.minY * scale)
    transform.scale(x: scale, y: -scale)
    glyph.transform(using: transform)

    let image = NSImage(size: NSSize(width: ceil(width), height: height))
    image.lockFocus()
    NSColor.black.setFill()
    glyph.fill()
    image.unlockFocus()
    image.isTemplate = true
    return image
  }

  /// Minimal SVG path reader: absolute M/L/H/V/Z with implicit-repeat args.
  private static func parse(_ d: String) -> NSBezierPath {
    let path = NSBezierPath()
    var current = NSPoint.zero
    var command: Character = " "
    var numbers: [CGFloat] = []

    func flush() {
      guard command != " " else { return }
      switch command {
      case "M":
        for i in stride(from: 0, to: numbers.count - 1, by: 2) {
          current = NSPoint(x: numbers[i], y: numbers[i + 1])
          // First pair moves; subsequent pairs are implicit lineto (SVG rule).
          if i == 0 { path.move(to: current) } else { path.line(to: current) }
        }
      case "L":
        for i in stride(from: 0, to: numbers.count - 1, by: 2) {
          current = NSPoint(x: numbers[i], y: numbers[i + 1])
          path.line(to: current)
        }
      case "H":
        for x in numbers {
          current = NSPoint(x: x, y: current.y)
          path.line(to: current)
        }
      case "V":
        for y in numbers {
          current = NSPoint(x: current.x, y: y)
          path.line(to: current)
        }
      case "Z":
        path.close()
      default:
        break
      }
      numbers = []
    }

    var token = ""
    func takeNumber() {
      if !token.isEmpty, let value = Double(token) { numbers.append(CGFloat(value)) }
      token = ""
    }

    for char in d {
      if char.isLetter {
        takeNumber()
        flush()
        command = char
      } else if char == " " {
        takeNumber()
      } else {
        token.append(char)  // digit or "."
      }
    }
    takeNumber()
    flush()
    return path
  }
}
