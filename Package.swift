// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SafariChatCore",
    platforms: [.macOS(.v14)],
    products: [.library(name: "SafariChatCore", targets: ["SafariChatCore"])],
    targets: [
        .target(name: "SafariChatCore", path: "native/Shared"),
        .testTarget(name: "SafariChatCoreTests", dependencies: ["SafariChatCore"], path: "tests/Native")
    ]
)
