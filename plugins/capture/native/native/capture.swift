import Foundation
import AppKit
import ApplicationServices

struct HelperConfig: Decodable {
  var raw_root: String?
  var poll_interval_ms: Int?
  var idle_threshold_sec: Int?
  var screenshot_format: String?
  var screenshot_quality: Int?
  var screenshot_max_dim: Int?
  var multi_screen: Bool?
  var screens: [Int]?
  var capture_mode: String?
  var fixture: Bool?
}

let args = CommandLine.arguments
let configJson = valueAfter("--config-json", in: args) ?? "{}"
let fixtureMode = args.contains("--fixture")
let config = (try? JSONDecoder().decode(HelperConfig.self, from: Data(configJson.utf8))) ?? HelperConfig()

func emit(_ obj: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
     let line = String(data: data, encoding: .utf8) {
    print(line)
    fflush(stdout)
  }
}

emit([
  "kind": "ready",
  "platform": platformName(),
  "arch": archName(),
  "capabilities": fixtureMode
    ? ["fixture-events", "ndjson-protocol"]
    : ["ndjson-protocol"]
])

if fixtureMode || config.fixture == true {
  runFixture(config: config)
} else {
  runMacCapture(config: config)
}

func runFixture(config: HelperConfig) {
  let now = ISO8601DateFormatter().string(from: Date())
  let eventId = "evt_" + String(Int(Date().timeIntervalSince1970 * 1000), radix: 36) + "_nativefixture"
  let sessionId = "sess_" + String(Int(Date().timeIntervalSince1970 * 1000), radix: 36) + "_native"
  let event: [String: Any] = [
    "id": eventId,
    "timestamp": now,
    "session_id": sessionId,
    "type": "screenshot",
    "app": "Native Fixture",
    "app_bundle_id": "os.cofounder.capture.native.fixture",
    "window_title": "Native capture fixture",
    "url": NSNull(),
    "content": NSNull(),
    "asset_path": NSNull(),
    "duration_ms": NSNull(),
    "idle_before_ms": NSNull(),
    "screen_index": 0,
    "metadata": [
      "source": "native-fixture",
      "protocol": "ndjson",
      "trigger": "fixture",
      "ax_text": "Native capture fixture event emitted through the sidecar protocol."
    ],
    "privacy_filtered": false,
    "capture_plugin": "native"
  ]
  emit(["kind": "event", "event": event])
  emit(["kind": "status", "cpuPercent": 0, "memoryMB": 8, "storageBytesToday": 0])

  // Keep the process alive briefly so the TS shim can exercise lifecycle
  // handling in capture --once / smoke tests, then exit cleanly.
  let deadline = Date().addingTimeInterval(2)
  while Date() < deadline {
    if let line = readStdinLineNonBlocking(), line.contains("\"kind\":\"stop\"") {
      break
    }
    Thread.sleep(forTimeInterval: 0.05)
  }
}

struct DisplayInfo {
  let index: Int
  let name: String
  let rect: CGRect
}

struct ActiveWindow {
  let app: String
  let bundleId: String
  let pid: pid_t
  let title: String
  let url: String?
  let bounds: CGRect?
  let screenIndex: Int

  var focusKey: String {
    "\(bundleId)|\(pid)|\(title)|\(screenIndex)"
  }
}

func runMacCapture(config: HelperConfig) {
  let sessionId = "sess_" + String(Int(Date().timeIntervalSince1970 * 1000), radix: 36) + "_native"
  let pollInterval = max(0.25, Double(config.poll_interval_ms ?? 1500) / 1000.0)
  let idleThreshold = Double(config.idle_threshold_sec ?? 60)
  let displays = enumerateDisplays()
  let selectedDisplays = selectDisplays(displays: displays, config: config)

  emit([
    "kind": "log",
    "level": "info",
    "message": "native macOS metadata capture started",
    "data": [
      "display_count": displays.count,
      "displays": displays.map { displayJson($0) },
      "selected_displays": selectedDisplays.map { displayJson($0) },
      "poll_interval_sec": pollInterval,
      "idle_threshold_sec": idleThreshold
    ]
  ])

  emitEvent(
    type: "app_launch",
    sessionId: sessionId,
    app: "CofounderOS",
    bundleId: "os.cofounder.capture.native",
    title: "capture-native started",
    url: nil,
    content: nil,
    durationMs: nil,
    idleBeforeMs: nil,
    screenIndex: 0,
    metadata: ["source": "native-macos"]
  )

  var paused = false
  var idle = false
  var lastWindow: ActiveWindow? = nil
  var lastEnteredAt = Date()
  var lastUrl: String? = nil

  while true {
    while let command = readStdinLineNonBlocking() {
      if command.contains("\"kind\":\"stop\"") { return }
      if command.contains("\"kind\":\"pause\"") { paused = true }
      if command.contains("\"kind\":\"resume\"") { paused = false }
    }

    if paused {
      Thread.sleep(forTimeInterval: pollInterval)
      continue
    }

    let idleSeconds = secondsSinceLastInput()
    if idleSeconds >= idleThreshold && !idle {
      idle = true
      emitEvent(
        type: "idle_start",
        sessionId: sessionId,
        app: "system",
        bundleId: "system",
        title: "idle",
        url: nil,
        content: nil,
        durationMs: nil,
        idleBeforeMs: Int(idleSeconds * 1000),
        screenIndex: lastWindow?.screenIndex ?? 0,
        metadata: ["threshold_sec": idleThreshold, "source": "native-macos"]
      )
    } else if idleSeconds < idleThreshold && idle {
      idle = false
      emitEvent(
        type: "idle_end",
        sessionId: sessionId,
        app: "system",
        bundleId: "system",
        title: "active",
        url: nil,
        content: nil,
        durationMs: nil,
        idleBeforeMs: Int(idleSeconds * 1000),
        screenIndex: lastWindow?.screenIndex ?? 0,
        metadata: ["source": "native-macos"]
      )
      if let lastWindow {
        captureScreenshots(
          trigger: "idle_end",
          window: lastWindow,
          sessionId: sessionId,
          displays: selectedDisplays,
          config: config
        )
      }
    }

    if let current = queryActiveWindow(displays: displays) {
      if lastWindow?.focusKey != current.focusKey {
        if let previous = lastWindow {
          emitEvent(
            type: "window_blur",
            sessionId: sessionId,
            app: previous.app,
            bundleId: previous.bundleId,
            title: previous.title,
            url: previous.url,
            content: nil,
            durationMs: Int(Date().timeIntervalSince(lastEnteredAt) * 1000),
            idleBeforeMs: nil,
            screenIndex: previous.screenIndex,
            metadata: [
              "pid": Int(previous.pid),
              "source": "native-macos"
            ]
          )
        }
        emitEvent(
          type: "window_focus",
          sessionId: sessionId,
          app: current.app,
          bundleId: current.bundleId,
          title: current.title,
          url: current.url,
          content: nil,
          durationMs: nil,
          idleBeforeMs: Int(idleSeconds * 1000),
          screenIndex: current.screenIndex,
          metadata: windowMetadata(current, displays: displays)
        )
        captureScreenshots(
          trigger: "window_focus",
          window: current,
          sessionId: sessionId,
          displays: selectedDisplays,
          config: config
        )
        lastWindow = current
        lastEnteredAt = Date()
        lastUrl = current.url
      } else if current.url != lastUrl {
        emitEvent(
          type: "url_change",
          sessionId: sessionId,
          app: current.app,
          bundleId: current.bundleId,
          title: current.title,
          url: current.url,
          content: nil,
          durationMs: nil,
          idleBeforeMs: Int(idleSeconds * 1000),
          screenIndex: current.screenIndex,
          metadata: [
            "pid": Int(current.pid),
            "previous_url": lastUrl as Any,
            "source": "native-macos"
          ]
        )
        captureScreenshots(
          trigger: "url_change",
          window: current,
          sessionId: sessionId,
          displays: selectedDisplays,
          config: config
        )
        lastUrl = current.url
      }
    }

    emit(["kind": "status", "cpuPercent": 0, "memoryMB": currentMemoryMB(), "storageBytesToday": 0])
    Thread.sleep(forTimeInterval: pollInterval)
  }
}

func emitEvent(
  type: String,
  sessionId: String,
  app: String,
  bundleId: String,
  title: String,
  url: String?,
  content: String?,
  assetPath: String? = nil,
  durationMs: Int?,
  idleBeforeMs: Int?,
  screenIndex: Int,
  metadata: [String: Any]
) {
  let now = Date()
  let event: [String: Any] = [
    "id": "evt_" + String(Int(now.timeIntervalSince1970 * 1000), radix: 36) + "_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased(),
    "timestamp": ISO8601DateFormatter().string(from: now),
    "session_id": sessionId,
    "type": type,
    "app": app,
    "app_bundle_id": bundleId,
    "window_title": title,
    "url": url ?? NSNull(),
    "content": content ?? NSNull(),
    "asset_path": assetPath ?? NSNull(),
    "duration_ms": durationMs ?? NSNull(),
    "idle_before_ms": idleBeforeMs ?? NSNull(),
    "screen_index": screenIndex,
    "metadata": metadata,
    "privacy_filtered": false,
    "capture_plugin": "native"
  ]
  emit(["kind": "event", "event": event])
}

func queryActiveWindow(displays: [DisplayInfo]) -> ActiveWindow? {
  guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
  let pid = app.processIdentifier
  let appName = app.localizedName ?? "unknown"
  let bundleId = app.bundleIdentifier ?? "unknown"
  let axApp = AXUIElementCreateApplication(pid)
  let window = focusedWindow(axApp)
  let title = window.flatMap { stringAttribute($0, kAXTitleAttribute) } ?? ""
  let bounds = window.flatMap { windowBounds($0) }
  let screenIndex = bounds.map { resolveScreenIndex(bounds: $0, displays: displays) } ?? 0
  let url = browserUrl(appName: appName)
  return ActiveWindow(
    app: appName,
    bundleId: bundleId,
    pid: pid,
    title: title,
    url: url,
    bounds: bounds,
    screenIndex: screenIndex
  )
}

func focusedWindow(_ axApp: AXUIElement) -> AXUIElement? {
  var ref: CFTypeRef?
  if AXUIElementCopyAttributeValue(axApp, kAXFocusedWindowAttribute as CFString, &ref) == .success,
     let win = ref {
    return (win as! AXUIElement)
  }
  if AXUIElementCopyAttributeValue(axApp, kAXMainWindowAttribute as CFString, &ref) == .success,
     let win = ref {
    return (win as! AXUIElement)
  }
  var windowsRef: CFTypeRef?
  if AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &windowsRef) == .success,
     let windows = windowsRef as? [AXUIElement] {
    return windows.first
  }
  return nil
}

func stringAttribute(_ element: AXUIElement, _ attr: String) -> String? {
  var ref: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attr as CFString, &ref) == .success,
        let value = ref as? String,
        !value.isEmpty else {
    return nil
  }
  return value
}

func windowBounds(_ element: AXUIElement) -> CGRect? {
  var posRef: CFTypeRef?
  var sizeRef: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &posRef) == .success,
        AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeRef) == .success,
        let posValue = posRef,
        let sizeValue = sizeRef else {
    return nil
  }
  var point = CGPoint.zero
  var size = CGSize.zero
  AXValueGetValue((posValue as! AXValue), .cgPoint, &point)
  AXValueGetValue((sizeValue as! AXValue), .cgSize, &size)
  return CGRect(origin: point, size: size)
}

func enumerateDisplays() -> [DisplayInfo] {
  let screens = NSScreen.screens
  let primaryHeight = screens.first?.frame.height ?? 0
  return screens.enumerated().map { idx, screen in
    let f = screen.frame
    let topYDown = primaryHeight - (f.origin.y + f.size.height)
    return DisplayInfo(
      index: idx,
      name: screen.localizedName,
      rect: CGRect(x: f.origin.x, y: topYDown, width: f.size.width, height: f.size.height)
    )
  }
}

func selectDisplays(displays: [DisplayInfo], config: HelperConfig) -> [DisplayInfo] {
  guard config.multi_screen == true else {
    return displays.first.map { [$0] } ?? []
  }
  if let wanted = config.screens, !wanted.isEmpty {
    let selected = displays.filter { wanted.contains($0.index) }
    return selected.isEmpty ? Array(displays.prefix(1)) : selected
  }
  return displays
}

func displaysForScreenshot(window: ActiveWindow, selected: [DisplayInfo], config: HelperConfig) -> [DisplayInfo] {
  if config.multi_screen == true && config.capture_mode == "all" {
    return selected
  }
  if let active = selected.first(where: { $0.index == window.screenIndex }) {
    return [active]
  }
  return selected.first.map { [$0] } ?? []
}

func captureScreenshots(
  trigger: String,
  window: ActiveWindow,
  sessionId: String,
  displays: [DisplayInfo],
  config: HelperConfig
) {
  let targets = displaysForScreenshot(window: window, selected: displays, config: config)
  for display in targets {
    if let asset = captureScreenshot(display: display, appName: window.app, config: config) {
      emitEvent(
        type: "screenshot",
        sessionId: sessionId,
        app: window.app,
        bundleId: window.bundleId,
        title: window.title,
        url: window.url,
        content: nil,
        assetPath: asset.relativePath,
        durationMs: nil,
        idleBeforeMs: nil,
        screenIndex: display.index,
        metadata: [
          "trigger": trigger,
          "source": "native-macos",
          "bytes": asset.bytes,
          "display_id": display.index,
          "display_name": display.name,
          "native_capture_method": "screencapture",
          "requested_format": config.screenshot_format ?? "webp",
          "actual_format": "jpeg"
        ]
      )
      emit(["kind": "status", "storageBytesToday": asset.bytes])
    }
  }
}

struct ScreenshotAsset {
  let relativePath: String
  let bytes: Int
}

func captureScreenshot(display: DisplayInfo, appName: String, config: HelperConfig) -> ScreenshotAsset? {
  let root = NSString(string: config.raw_root ?? NSHomeDirectory() + "/.cofounderOS").expandingTildeInPath
  let now = Date()
  let day = dayString(now)
  let time = timeString(now)
  let safeApp = safeFilename(appName)
  let suffix = display.index == 0 ? "" : "_s\(display.index)"
  let relative = "raw/\(day)/screenshots/\(time)_\(safeApp)\(suffix).jpg"
  let abs = URL(fileURLWithPath: root).appendingPathComponent(relative).path
  do {
    try FileManager.default.createDirectory(
      atPath: URL(fileURLWithPath: abs).deletingLastPathComponent().path,
      withIntermediateDirectories: true
    )
  } catch {
    emit(["kind": "error", "code": "screenshot_dir_failed", "message": String(describing: error)])
    return nil
  }

  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
  process.arguments = ["-x", "-t", "jpg", "-D", "\(display.index + 1)", abs]
  process.standardOutput = Pipe()
  process.standardError = Pipe()
  do {
    try process.run()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else {
      emit(["kind": "error", "code": "screenshot_failed", "message": "screencapture exited \(process.terminationStatus)"])
      return nil
    }
    if let maxDim = config.screenshot_max_dim, maxDim > 0 {
      resizeImageInPlace(abs, maxDim: maxDim)
    }
    let attrs = try FileManager.default.attributesOfItem(atPath: abs)
    let bytes = (attrs[.size] as? NSNumber)?.intValue ?? 0
    return ScreenshotAsset(relativePath: relative, bytes: bytes)
  } catch {
    emit(["kind": "error", "code": "screenshot_failed", "message": String(describing: error)])
    return nil
  }
}

func resizeImageInPlace(_ path: String, maxDim: Int) {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/bin/sips")
  process.arguments = ["-Z", "\(maxDim)", path]
  process.standardOutput = Pipe()
  process.standardError = Pipe()
  do {
    try process.run()
    process.waitUntilExit()
  } catch {
    // Non-fatal: keep the native-resolution screenshot.
  }
}

func dayString(_ date: Date) -> String {
  let formatter = DateFormatter()
  formatter.calendar = Calendar(identifier: .gregorian)
  formatter.locale = Locale(identifier: "en_US_POSIX")
  formatter.dateFormat = "yyyy-MM-dd"
  return formatter.string(from: date)
}

func timeString(_ date: Date) -> String {
  let formatter = DateFormatter()
  formatter.calendar = Calendar(identifier: .gregorian)
  formatter.locale = Locale(identifier: "en_US_POSIX")
  formatter.dateFormat = "HH-mm-ss"
  return formatter.string(from: date)
}

func safeFilename(_ value: String) -> String {
  let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-")
  let scalars = value.unicodeScalars.map { allowed.contains($0) ? Character($0) : "_" }
  let out = String(scalars).prefix(40)
  return out.isEmpty ? "unknown" : String(out)
}

func resolveScreenIndex(bounds: CGRect, displays: [DisplayInfo]) -> Int {
  guard !displays.isEmpty else { return 0 }
  var bestIndex = displays[0].index
  var bestArea: CGFloat = 0
  for display in displays {
    let intersection = bounds.intersection(display.rect)
    let area = intersection.isNull ? 0 : intersection.width * intersection.height
    if area > bestArea {
      bestArea = area
      bestIndex = display.index
    }
  }
  if bestArea > 0 { return bestIndex }
  let center = CGPoint(x: bounds.midX, y: bounds.midY)
  return displays.first(where: { $0.rect.contains(center) })?.index ?? 0
}

func displayJson(_ display: DisplayInfo) -> [String: Any] {
  [
    "index": display.index,
    "name": display.name,
    "rect": [
      "left": display.rect.origin.x,
      "top": display.rect.origin.y,
      "width": display.rect.width,
      "height": display.rect.height
    ]
  ]
}

func windowMetadata(_ window: ActiveWindow, displays: [DisplayInfo]) -> [String: Any] {
  var metadata: [String: Any] = [
    "pid": Int(window.pid),
    "source": "native-macos",
    "display_count": displays.count
  ]
  if let bounds = window.bounds {
    metadata["bounds"] = [
      "x": bounds.origin.x,
      "y": bounds.origin.y,
      "width": bounds.width,
      "height": bounds.height
    ]
  }
  if let display = displays.first(where: { $0.index == window.screenIndex }) {
    metadata["display_name"] = display.name
  }
  return metadata
}

func browserUrl(appName: String) -> String? {
  let script: String?
  switch appName {
  case "Google Chrome", "Google Chrome Canary", "Google Chrome Beta", "Brave Browser", "Brave Browser Beta", "Brave Browser Nightly", "Microsoft Edge", "Microsoft Edge Beta", "Microsoft Edge Dev", "Arc", "Vivaldi", "Chromium", "Opera", "Opera GX", "Sidekick":
    script = "tell application \"\(appName)\" to return URL of active tab of front window"
  case "Safari", "Safari Technology Preview", "Orion", "Orion RC":
    script = "tell application \"\(appName)\" to return URL of front document"
  default:
    script = nil
  }
  guard let script else { return nil }
  let process = Process()
  let pipe = Pipe()
  process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
  process.arguments = ["-e", script]
  process.standardOutput = pipe
  process.standardError = Pipe()
  do {
    try process.run()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else { return nil }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    let out = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
    return out?.isEmpty == false ? out : nil
  } catch {
    return nil
  }
}

func secondsSinceLastInput() -> TimeInterval {
  let eventTypes: [CGEventType] = [.keyDown, .leftMouseDown, .rightMouseDown, .mouseMoved, .scrollWheel]
  let values = eventTypes.map {
    CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: $0)
  }.filter { $0.isFinite && $0 >= 0 }
  return values.min() ?? 0
}

func currentMemoryMB() -> Int {
  var info = mach_task_basic_info()
  var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size) / 4
  let result = withUnsafeMutablePointer(to: &info) {
    $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
      task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count)
    }
  }
  if result != KERN_SUCCESS { return 0 }
  return Int(info.resident_size / 1024 / 1024)
}

func valueAfter(_ flag: String, in args: [String]) -> String? {
  guard let idx = args.firstIndex(of: flag), idx + 1 < args.count else { return nil }
  return args[idx + 1]
}

func platformName() -> String {
  #if os(macOS)
  return "darwin"
  #elseif os(Linux)
  return "linux"
  #elseif os(Windows)
  return "win32"
  #else
  return "unknown"
  #endif
}

func archName() -> String {
  #if arch(arm64)
  return "arm64"
  #elseif arch(x86_64)
  return "x64"
  #else
  return "unknown"
  #endif
}

func readStdinLineNonBlocking() -> String? {
  var readfds = fd_set()
  fdZero(&readfds)
  fdSet(STDIN_FILENO, &readfds)
  var timeout = timeval(tv_sec: 0, tv_usec: 0)
  let ready = select(STDIN_FILENO + 1, &readfds, nil, nil, &timeout)
  guard ready > 0 else { return nil }
  return readLine()
}

// Darwin's fd_set helpers are macros in C, so Swift needs tiny wrappers.
func fdZero(_ set: inout fd_set) {
  memset(&set, 0, MemoryLayout<fd_set>.size)
}

func fdSet(_ fd: Int32, _ set: inout fd_set) {
  let intOffset = Int(fd) / (MemoryLayout<Int32>.size * 8)
  let bitOffset = Int(fd) % (MemoryLayout<Int32>.size * 8)
  withUnsafeMutablePointer(to: &set) {
    $0.withMemoryRebound(to: Int32.self, capacity: MemoryLayout<fd_set>.size / MemoryLayout<Int32>.size) {
      $0[intOffset] |= (1 << Int32(bitOffset))
    }
  }
}
