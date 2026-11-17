import AppKit
import Foundation

let root = URL(fileURLWithPath: CommandLine.arguments[1])
let iconDirectory = root.appendingPathComponent("extension/icons")
let iconset = root.appendingPathComponent("build/AppIcon.iconset")
try FileManager.default.createDirectory(at: iconDirectory, withIntermediateDirectories: true)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)

guard let logo = NSImage(contentsOf: root.appendingPathComponent("extension/icons/openai-blossom.svg")) else {
    fatalError("The bundled OpenAI logo could not be loaded.")
}

func png(_ size: Int, toolbar: Bool = false) -> Data {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    let s = CGFloat(size)
    if !toolbar {
        NSColor.white.setFill()
        NSBezierPath(roundedRect: NSRect(x: s * 0.035, y: s * 0.035, width: s * 0.93, height: s * 0.93), xRadius: s * 0.23, yRadius: s * 0.23).fill()
    }
    // Keep the original vector's proportions and clear space. Toolbar images
    // have no tile so Safari can tint the mark without producing a solid square.
    logo.draw(in: NSRect(x: 0, y: 0, width: s, height: s), from: .zero, operation: .sourceOver, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
    return bitmap.representation(using: .png, properties: [:])!
}
for size in [48, 64, 96, 128, 256, 512] { try png(size).write(to: iconDirectory.appendingPathComponent("icon-\(size).png")) }
for size in [16, 32, 128, 256, 512] {
    try png(size).write(to: iconset.appendingPathComponent("icon_\(size)x\(size).png"))
    try png(size * 2).write(to: iconset.appendingPathComponent("icon_\(size)x\(size)@2x.png"))
}

for size in [16, 19, 32, 38, 64] { try png(size, toolbar: true).write(to: iconDirectory.appendingPathComponent("toolbar-\(size).png")) }
