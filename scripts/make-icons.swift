import AppKit
import Foundation

let root = URL(fileURLWithPath: CommandLine.arguments[1])
let iconDirectory = root.appendingPathComponent("extension/icons")
let iconset = root.appendingPathComponent("build/AppIcon.iconset")
try FileManager.default.createDirectory(at: iconDirectory, withIntermediateDirectories: true)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)

func png(_ size: Int) -> Data {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    let s = CGFloat(size)
    NSColor(calibratedRed: 0.20, green: 0.36, blue: 0.28, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: s * 0.035, y: s * 0.035, width: s * 0.93, height: s * 0.93), xRadius: s * 0.23, yRadius: s * 0.23).fill()
    NSColor(calibratedRed: 0.96, green: 0.96, blue: 0.90, alpha: 1).setFill()
    let shape = NSBezierPath()
    for index in 0..<24 {
        let angle = CGFloat(index) * .pi / 12
        let radius: CGFloat = index % 3 == 0 ? 0.34 : 0.145
        let point = NSPoint(x: s * (0.5 + cos(angle) * radius), y: s * (0.5 + sin(angle) * radius))
        index == 0 ? shape.move(to: point) : shape.line(to: point)
    }
    shape.close(); shape.fill()
    NSGraphicsContext.restoreGraphicsState()
    return bitmap.representation(using: .png, properties: [:])!
}
for size in [32, 48, 64, 128, 256] { try png(size).write(to: iconDirectory.appendingPathComponent("icon-\(size).png")) }
for size in [16, 32, 128, 256, 512] {
    try png(size).write(to: iconset.appendingPathComponent("icon_\(size)x\(size).png"))
    try png(size * 2).write(to: iconset.appendingPathComponent("icon_\(size)x\(size)@2x.png"))
}
