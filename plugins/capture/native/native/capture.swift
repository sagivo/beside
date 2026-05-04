import Foundation
import AppKit
import ApplicationServices
import AVFoundation

struct HelperConfig: Decodable {
  var raw_root: String?
  var capture_audio: Bool?
  var audio: AudioConfig?
  var poll_interval_ms: Int?
  var idle_threshold_sec: Int?
  var screenshot_format: String?
  var screenshot_quality: Int?
  var screenshot_max_dim: Int?
  var content_change_min_interval_ms: Int?
  var multi_screen: Bool?
  var screens: [Int]?
  var capture_mode: String?
  var accessibility: AccessibilityConfig?
  var fixture: Bool?
}

struct AudioConfig: Decodable {
  var inbox_path: String?
  var live_recording: LiveRecordingConfig?
}

struct LiveRecordingConfig: Decodable {
  var enabled: Bool?
  var chunk_seconds: Int?
  var format: String?
  var sample_rate: Int?
  var channels: Int?
}

struct AccessibilityConfig: Decodable {
  var enabled: Bool?
  var max_chars: Int?
  var max_elements: Int?
  var excluded_apps: [String]?
}

let args = CommandLine.arguments
let configJson = valueAfter("--config-json", in: args) ?? "{}"
let fixtureMode = args.contains("--fixture")
let config = (try? JSONDecoder().decode(HelperConfig.self, from: Data(configJson.utf8))) ?? HelperConfig()

if args.contains("--doctor") {
  emitDoctor()
  exit(0)
}

func emit(_ obj: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
     let line = String(data: data, encoding: .utf8) {
    print(line)
    fflush(stdout)
  }
}

func emitDoctor() {
  let micStatus = AVCaptureDevice.authorizationStatus(for: .audio)
  let checks: [[String: Any]] = [
    [
      "id": "screen-recording",
      "status": CGPreflightScreenCaptureAccess() ? "ok" : "warn",
      "message": CGPreflightScreenCaptureAccess()
        ? "Screen Recording permission appears granted"
        : "Screen Recording permission is not granted or has not been requested",
      "detail": "Required for native screenshots. Grant access in System Settings > Privacy & Security > Screen Recording."
    ],
    [
      "id": "accessibility",
      "status": AXIsProcessTrusted() ? "ok" : "warn",
      "message": AXIsProcessTrusted()
        ? "Accessibility permission appears granted"
        : "Accessibility permission is not granted",
      "detail": "Required for focused-window metadata and AX text. Grant access in System Settings > Privacy & Security > Accessibility."
    ],
    [
      "id": "microphone",
      "status": microphoneDoctorStatus(micStatus),
      "message": microphoneDoctorMessage(micStatus),
      "detail": "Required only when capture.audio.live_recording.enabled is true. Grant access in System Settings > Privacy & Security > Microphone."
    ],
    [
      "id": "screencapture-cli",
      "status": FileManager.default.isExecutableFile(atPath: "/usr/sbin/screencapture") ? "ok" : "fail",
      "message": FileManager.default.isExecutableFile(atPath: "/usr/sbin/screencapture")
        ? "screencapture helper found"
        : "screencapture helper missing",
      "detail": "/usr/sbin/screencapture"
    ],
    [
      "id": "osascript-cli",
      "status": FileManager.default.isExecutableFile(atPath: "/usr/bin/osascript") ? "ok" : "warn",
      "message": FileManager.default.isExecutableFile(atPath: "/usr/bin/osascript")
        ? "osascript helper found"
        : "osascript helper missing",
      "detail": "Used for browser URL extraction and Automation permission prompts."
    ],
    [
      "id": "displays",
      "status": NSScreen.screens.isEmpty ? "warn" : "ok",
      "message": "\(NSScreen.screens.count) display(s) visible to native helper",
      "detail": "Native screenshots are taken per display with screencapture -D."
    ]
  ]
  emit([
    "kind": "doctor",
    "platform": platformName(),
    "arch": archName(),
    "checks": checks
  ])
}

func microphoneDoctorStatus(_ status: AVAuthorizationStatus) -> String {
  switch status {
  case .authorized:
    return "ok"
  case .notDetermined:
    return "info"
  case .denied, .restricted:
    return "warn"
  @unknown default:
    return "warn"
  }
}

func microphoneDoctorMessage(_ status: AVAuthorizationStatus) -> String {
  switch status {
  case .authorized:
    return "Microphone permission appears granted"
  case .notDetermined:
    return "Microphone permission has not been requested"
  case .denied:
    return "Microphone permission is denied"
  case .restricted:
    return "Microphone permission is restricted"
  @unknown default:
    return "Microphone permission status is unknown"
  }
}

emit([
  "kind": "ready",
  "platform": platformName(),
  "arch": archName(),
  "capabilities": fixtureMode
    ? ["fixture-events", "ndjson-protocol"]
    : ["ndjson-protocol", "metadata", "screenshots", "ax-text", "audio-chunks"]
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
  let contentChangeInterval = max(0, Double(config.content_change_min_interval_ms ?? 20_000) / 1000.0)
  let displays = enumerateDisplays()
  let selectedDisplays = selectDisplays(displays: displays, config: config)
  let audioChunker = AudioChunker(config: config)
  audioChunker.startIfEnabled()

  emit([
    "kind": "log",
    "level": "info",
    "message": "native macOS metadata capture started",
    "data": [
      "display_count": displays.count,
      "displays": displays.map { displayJson($0) },
      "selected_displays": selectedDisplays.map { displayJson($0) },
      "poll_interval_sec": pollInterval,
      "content_change_interval_sec": contentChangeInterval,
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
  var lastSoftCaptureAt = Date.distantPast

  while true {
    while let command = readStdinLineNonBlocking() {
      if command.contains("\"kind\":\"stop\"") {
        audioChunker.stop()
        return
      }
      if command.contains("\"kind\":\"pause\"") { paused = true }
      if command.contains("\"kind\":\"resume\"") { paused = false }
    }

    if paused {
      audioChunker.tick()
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
        lastSoftCaptureAt = Date()
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
        lastSoftCaptureAt = Date()
        lastUrl = current.url
      } else if !idle && contentChangeInterval > 0 && Date().timeIntervalSince(lastSoftCaptureAt) >= contentChangeInterval {
        captureScreenshots(
          trigger: "content_change",
          window: current,
          sessionId: sessionId,
          displays: selectedDisplays,
          config: config
        )
        lastSoftCaptureAt = Date()
      }
    }

    emit(["kind": "status", "cpuPercent": 0, "memoryMB": currentMemoryMB(), "storageBytesToday": 0])
    audioChunker.tick()
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
      let ax = accessibilityText(window: window, config: config)
      var metadata: [String: Any] = [
        "trigger": trigger,
        "source": "native-macos",
        "bytes": asset.bytes,
        "display_id": display.index,
        "display_name": display.name,
        "native_capture_method": "screencapture",
        "requested_format": config.screenshot_format ?? "webp",
        "actual_format": "jpeg"
      ]
      if let ax {
        metadata["ax_text"] = ax.text
        metadata["ax_text_chars"] = ax.text.count
        metadata["ax_text_truncated"] = ax.truncated
        metadata["ax_text_duration_ms"] = ax.durationMs
      }
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
        metadata: metadata
      )
      emit(["kind": "status", "storageBytesToday": asset.bytes])
    }
  }
}

struct ScreenshotAsset {
  let relativePath: String
  let bytes: Int
}

struct AccessibilityText {
  let text: String
  let truncated: Bool
  let durationMs: Int
}

func accessibilityText(window: ActiveWindow, config: HelperConfig) -> AccessibilityText? {
  let cfg = config.accessibility
  if cfg?.enabled == false { return nil }
  let excluded = Set((cfg?.excluded_apps ?? []).map { $0.lowercased() })
  if excluded.contains(window.app.lowercased()) { return nil }

  let maxChars = cfg?.max_chars ?? 8000
  let maxElements = cfg?.max_elements ?? 4000
  let start = Date()
  let app = AXUIElementCreateApplication(window.pid)
  guard let root = focusedWindow(app) else { return nil }

  var stack: [AXUIElement] = [root]
  var text = ""
  var visited = 0

  while let element = stack.popLast() {
    if text.count >= maxChars || visited >= maxElements { break }
    visited += 1
    appendTextAttribute(element, kAXValueAttribute, into: &text, maxChars: maxChars)
    appendTextAttribute(element, kAXTitleAttribute, into: &text, maxChars: maxChars)
    appendTextAttribute(element, kAXDescriptionAttribute, into: &text, maxChars: maxChars)
    appendTextAttribute(element, kAXHelpAttribute, into: &text, maxChars: maxChars)
    appendTextAttribute(element, kAXPlaceholderValueAttribute, into: &text, maxChars: maxChars)
    for child in childrenOf(element).reversed() {
      stack.append(child)
    }
  }

  let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
  guard cleaned.count >= 8 else { return nil }
  return AccessibilityText(
    text: cleaned,
    truncated: text.count >= maxChars || visited >= maxElements,
    durationMs: Int(Date().timeIntervalSince(start) * 1000)
  )
}

func appendTextAttribute(_ element: AXUIElement, _ attr: String, into text: inout String, maxChars: Int) {
  guard text.count < maxChars else { return }
  var ref: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attr as CFString, &ref) == .success,
        let value = ref else {
    return
  }
  let str: String?
  if let s = value as? String {
    str = s
  } else if let n = value as? NSNumber {
    str = n.stringValue
  } else {
    str = nil
  }
  guard let str, str.count > 1, str != "missing value" else { return }
  let remaining = max(0, maxChars - text.count)
  if remaining == 0 { return }
  text += String(str.prefix(remaining))
  if text.count < maxChars { text += "\n" }
}

func childrenOf(_ element: AXUIElement) -> [AXUIElement] {
  var ref: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &ref) == .success,
        let children = ref as? [AXUIElement] else {
    return []
  }
  return children
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
  // Include milliseconds so a hard-trigger screenshot and a subsequent
  // content_change probe in the same second never collide. Collisions
  // are dangerous because the TS shim may delete low-diff soft-trigger
  // assets after hashing.
  formatter.dateFormat = "HH-mm-ss-SSS"
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

final class AudioChunker: NSObject, AVAudioRecorderDelegate {
  private let enabled: Bool
  private let inboxPath: String
  private let partialPath: String
  private let chunkSeconds: TimeInterval
  private let sampleRate: Int
  private let channels: Int
  private var recorder: AVAudioRecorder?
  private var currentStartedAt: Date?
  private var currentPartialURL: URL?
  private var currentFinalURL: URL?
  private var chunkIndex = 0

  init(config: HelperConfig) {
    let live = config.audio?.live_recording
    self.enabled = (config.capture_audio == true) && (live?.enabled == true)
    self.inboxPath = NSString(
      string: config.audio?.inbox_path ?? "~/.cofounderOS/raw/audio/inbox"
    ).expandingTildeInPath
    self.partialPath = (self.inboxPath as NSString).appendingPathComponent(".partial")
    self.chunkSeconds = TimeInterval(max(1, live?.chunk_seconds ?? 300))
    self.sampleRate = live?.sample_rate ?? 16_000
    self.channels = live?.channels ?? 1
  }

  func startIfEnabled() {
    guard enabled else { return }
    guard ensureMicrophonePermission() else {
      emit([
        "kind": "error",
        "code": "audio_permission_denied",
        "message": "Native live audio recording is enabled but microphone permission is not granted.",
        "fatal": false
      ])
      return
    }
    do {
      try FileManager.default.createDirectory(
        atPath: inboxPath,
        withIntermediateDirectories: true
      )
      try FileManager.default.createDirectory(
        atPath: partialPath,
        withIntermediateDirectories: true
      )
      try reapStalePartials()
      try startNewChunk()
      emit([
        "kind": "log",
        "level": "info",
        "message": "native live audio chunking started",
        "data": [
          "inbox_path": inboxPath,
          "chunk_seconds": chunkSeconds,
          "sample_rate": sampleRate,
          "channels": channels
        ]
      ])
    } catch {
      emit([
        "kind": "error",
        "code": "audio_recording_failed",
        "message": String(describing: error),
        "fatal": false
      ])
    }
  }

  func tick() {
    guard enabled, recorder != nil, let started = currentStartedAt else { return }
    if Date().timeIntervalSince(started) >= chunkSeconds {
      rotate()
    }
  }

  func stop() {
    recorder?.stop()
    recorder = nil
    currentStartedAt = nil
    finalizeCurrentChunk()
  }

  private func rotate() {
    recorder?.stop()
    recorder = nil
    currentStartedAt = nil
    finalizeCurrentChunk()
    do {
      try startNewChunk()
    } catch {
      emit([
        "kind": "error",
        "code": "audio_chunk_rotate_failed",
        "message": String(describing: error),
        "fatal": false
      ])
    }
  }

  /// Atomically promote the just-finished partial file into the inbox so
  /// the Node-side worker only ever sees fully-flushed chunks.
  private func finalizeCurrentChunk() {
    guard let partial = currentPartialURL, let final = currentFinalURL else { return }
    currentPartialURL = nil
    currentFinalURL = nil
    let fm = FileManager.default
    guard fm.fileExists(atPath: partial.path) else { return }
    do {
      if fm.fileExists(atPath: final.path) {
        try fm.removeItem(at: final)
      }
      try fm.moveItem(at: partial, to: final)
    } catch {
      emit([
        "kind": "error",
        "code": "audio_chunk_finalize_failed",
        "message": String(describing: error),
        "fatal": false
      ])
    }
  }

  /// Anything in `.partial/` at startup is from a previous helper that
  /// crashed mid-chunk. AVAudioRecorder writes the m4a moov atom only on
  /// `.stop()`, so these files are not playable and Whisper would reject
  /// them. Discard rather than promoting to the inbox.
  private func reapStalePartials() throws {
    let fm = FileManager.default
    let partialURL = URL(fileURLWithPath: partialPath)
    let entries = (try? fm.contentsOfDirectory(at: partialURL, includingPropertiesForKeys: nil)) ?? []
    if entries.isEmpty { return }
    for entry in entries {
      try? fm.removeItem(at: entry)
    }
    emit([
      "kind": "log",
      "level": "warn",
      "message": "discarded stale audio partials from previous run",
      "data": ["count": entries.count]
    ])
  }

  private func startNewChunk() throws {
    chunkIndex += 1
    let filename = "native-\(dayString(Date()))-\(timeString(Date()))-\(chunkIndex).m4a"
    let url = URL(fileURLWithPath: partialPath).appendingPathComponent(filename)
    let finalURL = URL(fileURLWithPath: inboxPath).appendingPathComponent(filename)
    let settings: [String: Any] = [
      AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
      AVSampleRateKey: sampleRate,
      AVNumberOfChannelsKey: channels,
      AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue
    ]
    let recorder = try AVAudioRecorder(url: url, settings: settings)
    recorder.delegate = self
    recorder.isMeteringEnabled = false
    guard recorder.prepareToRecord(), recorder.record() else {
      throw NSError(
        domain: "cofounderos.audio",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "AVAudioRecorder failed to start"]
      )
    }
    self.recorder = recorder
    self.currentStartedAt = Date()
    self.currentPartialURL = url
    self.currentFinalURL = finalURL
  }

  private func ensureMicrophonePermission() -> Bool {
    let status = AVCaptureDevice.authorizationStatus(for: .audio)
    switch status {
    case .authorized:
      return true
    case .notDetermined:
      let semaphore = DispatchSemaphore(value: 0)
      var granted = false
      AVCaptureDevice.requestAccess(for: .audio) { ok in
        granted = ok
        semaphore.signal()
      }
      _ = semaphore.wait(timeout: .now() + 30)
      return granted
    default:
      return false
    }
  }
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
