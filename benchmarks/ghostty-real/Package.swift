// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "ghostty-real-bench",
  platforms: [
    .macOS(.v13),
  ],
  products: [
    .executable(
      name: "ghostty-real-bench",
      targets: ["ghostty-real-bench"]
    )
  ],
  targets: [
    .binaryTarget(
      name: "GhosttyKit",
      path: "Vendor/GhosttyKit.xcframework"
    ),
    .executableTarget(
      name: "ghostty-real-bench",
      dependencies: ["GhosttyKit"],
      linkerSettings: [
        .linkedFramework("Carbon"),
        .linkedLibrary("stdc++"),
      ]
    ),
  ]
)
