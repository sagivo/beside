import Foundation
import AppKit
import ApplicationServices
import AVFoundation
import AudioToolbox
import CoreAudio
import CoreGraphics
import ImageIO
import ScreenCaptureKit
import Vision

struct HelperConfig: Decodable {
  var raw_root: String?
  var capture_audio: Bool?
  var audio: AudioConfig?
  var poll_interval_ms: Int?
  var idle_poll_interval_ms: Int?
  var focus_settle_delay_ms: Int?
  var idle_threshold_sec: Int?
  var screenshot_format: String?
  var screenshot_quality: Int?
  var screenshot_max_dim: Int?
  var content_change_min_interval_ms: Int?
  var excluded_apps: [String]?
  var excluded_url_patterns: [String]?
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
  var system_audio_backend: String?
  var activation: String?
  var poll_interval_sec: Int?
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
    "app_bundle_id": "so.beside.capture.native.fixture",
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

struct PendingFocusCapture {
  let window: ActiveWindow
  let dueAt: Date
}

func runMacCapture(config: HelperConfig) {
  let sessionId = "sess_" + String(Int(Date().timeIntervalSince1970 * 1000), radix: 36) + "_native"
  let pollInterval = max(0.25, Double(config.poll_interval_ms ?? 3000) / 1000.0)
  let idlePollInterval = max(pollInterval, Double(config.idle_poll_interval_ms ?? 30_000) / 1000.0)
  let focusSettleDelay = max(0, Double(config.focus_settle_delay_ms ?? 900) / 1000.0)
  let idleThreshold = Double(config.idle_threshold_sec ?? 60)
  let contentChangeInterval = max(0, Double(config.content_change_min_interval_ms ?? 60_000) / 1000.0)
  let displays = enumerateDisplays()
  let selectedDisplays = selectDisplays(displays: displays, config: config)
  let audioChunker = AudioChunker(config: config)
  audioChunker.startIfEnabled()

  let sysAudio = makeSystemAudioHandle(config: config)

  emit([
    "kind": "log",
    "level": "info",
    "message": "native macOS metadata capture started",
    "data": [
      "display_count": displays.count,
      "displays": displays.map { displayJson($0) },
      "selected_displays": selectedDisplays.map { displayJson($0) },
      "poll_interval_sec": pollInterval,
      "idle_poll_interval_sec": idlePollInterval,
      "focus_settle_delay_sec": focusSettleDelay,
      "content_change_interval_sec": contentChangeInterval,
      "idle_threshold_sec": idleThreshold
    ]
  ])

  emitEvent(
    type: "app_launch",
    sessionId: sessionId,
    app: "Beside",
    bundleId: "so.beside.capture.native",
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
  var pendingFocusCapture: PendingFocusCapture? = nil
  // Throttle the periodic status emit. Previously fired every poll
  // (every 3 s when active = 20/min), waking the Node-side stdout
  // reader and recomputing memory via mach_task_basic_info each time.
  // The status payload only carries memoryMB; the Node side already
  // has its own status sources for capture counters. Cap to one emit
  // every ~10 s plus one on memory delta > 8 MB.
  var lastStatusEmitAt = Date.distantPast
  var lastStatusMemoryMB = 0
  let statusEmitMinInterval: TimeInterval = 10

  // Outer iteration is wrapped in an autoreleasepool below. Swift's
  // `continue` / `return` keywords can't cross a closure boundary, so
  // we communicate "skip the rest of this tick" / "exit the loop" via
  // a small enum and act on it after the pool drains.
  enum TickAction { case next, stop }

  while true {
    let action: TickAction = autoreleasepool { () -> TickAction in
    while let command = readStdinLineNonBlocking() {
      if command.contains("\"kind\":\"stop\"") {
        audioChunker.stop()
        sysAudio?.stop()
        return .stop
      }
      if command.contains("\"kind\":\"pause\"") {
        paused = true
        audioChunker.stop()
        sysAudio?.stop()
        pendingFocusCapture = nil
      }
      if command.contains("\"kind\":\"resume\"") { paused = false }
    }

    if paused {
      audioChunker.tick(paused: true)
      // sysAudio is already stopped on pause; nothing to tick
      Thread.sleep(forTimeInterval: idlePollInterval)
      return .next
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
        _ = captureScreenshots(
          trigger: "idle_end",
          window: lastWindow,
          sessionId: sessionId,
          displays: selectedDisplays,
          config: config
        )
      }
    }

    var currentWindow: ActiveWindow? = nil
    if let current = queryActiveWindow(displays: displays) {
      currentWindow = current
      if isExcluded(window: current, config: config) {
        pendingFocusCapture = nil
        if let previous = lastWindow, !isExcluded(window: previous, config: config) {
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
              "source": "native-macos",
              "privacy_transition": "excluded"
            ]
          )
        }
        lastWindow = current
        lastEnteredAt = Date()
        lastUrl = current.url
      } else if (lastWindow.map { isExcluded(window: $0, config: config) } ?? false) || lastWindow?.focusKey != current.focusKey {
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
        pendingFocusCapture = PendingFocusCapture(
          window: current,
          dueAt: Date().addingTimeInterval(focusSettleDelay)
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
        _ = captureScreenshots(
          trigger: "url_change",
          window: current,
          sessionId: sessionId,
          displays: selectedDisplays,
          config: config
        )
        lastSoftCaptureAt = Date()
        pendingFocusCapture = nil
        lastUrl = current.url
      } else if !idle && pendingFocusCapture == nil && contentChangeInterval > 0 && Date().timeIntervalSince(lastSoftCaptureAt) >= contentChangeInterval {
        _ = captureScreenshots(
          trigger: "content_change",
          window: current,
          sessionId: sessionId,
          displays: selectedDisplays,
          config: config
        )
        lastSoftCaptureAt = Date()
      }
    }

    if !idle, let pending = pendingFocusCapture, Date() >= pending.dueAt {
      _ = captureScreenshots(
        trigger: "window_focus",
        window: currentWindow ?? pending.window,
        sessionId: sessionId,
        displays: selectedDisplays,
        config: config
      )
      lastSoftCaptureAt = Date()
      pendingFocusCapture = nil
    }

    let nowTs = Date()
    if nowTs.timeIntervalSince(lastStatusEmitAt) >= statusEmitMinInterval {
      let memMB = currentMemoryMB()
      if abs(memMB - lastStatusMemoryMB) >= 8 || lastStatusEmitAt == Date.distantPast {
        emit(["kind": "status", "cpuPercent": 0, "memoryMB": memMB, "storageBytesToday": 0])
        lastStatusMemoryMB = memMB
      }
      lastStatusEmitAt = nowTs
    }
    audioChunker.tick(paused: false)
    sysAudio?.tick()
    Thread.sleep(forTimeInterval: idle ? idlePollInterval : pollInterval)
    return .next
    }
    if case .stop = action { return }
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
    "timestamp": DateFormatters.iso.string(from: now),
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
  let url = browserUrl(appName: appName, pid: pid, title: title)
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

func liveMeetingEvidence(window: ActiveWindow, text: String?) -> Bool {
  let metadata = [
    window.app,
    window.title,
    window.url ?? ""
  ].joined(separator: "\n")

  if hasActualMeetingUrl(metadata) || hasMeetingTitleLine(metadata) {
    return true
  }

  let app = window.app.lowercased()
  if app.contains("zoom") || app.contains("microsoft teams") || app == "teams" || app.contains("webex") {
    return true
  }
  if app.contains("google meet") {
    return true
  }

  guard let text, !text.isEmpty else { return false }
  if hasActualMeetingUrl(text) && hasMeetingUiText(text) {
    return true
  }
  return false
}

func hasActualMeetingUrl(_ text: String) -> Bool {
  regexMatch(#"meet\.google\.com/[a-z]{3}-[a-z]{4}-[a-z]{3}"#, text)
    || regexMatch(#"zoom\.us/(?:j|my|wc)/"#, text)
    || regexMatch(#"teams\.microsoft\.com/(?:l/meetup-join|_#/meetup)"#, text)
    || regexMatch(#"webex\.com/(?:meet|join)/"#, text)
    || regexMatch(#"whereby\.com/[A-Za-z0-9_-]{3,}"#, text)
    || regexMatch(#"around\.co/(?:app/)?[A-Za-z0-9_-]{3,}"#, text)
}

func hasMeetingTitleLine(_ text: String) -> Bool {
  for rawLine in text.components(separatedBy: .newlines) {
    let line = rawLine
      .trimmingCharacters(in: CharacterSet(charactersIn: " \t•*·-"))
      .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
    if line.isEmpty { continue }
    if regexMatch(#"^(?:Google\s+)?Meet\s*[-–—]\s*.{3,80}$"#, line) { return true }
    if regexMatch(#"^Zoom(?:\s+Meeting)?\s*[-–—]\s*.{3,80}$"#, line) { return true }
    if regexMatch(#"^(?:Microsoft\s+)?Teams\s*[-–—]\s*.{3,80}$"#, line) { return true }
    if regexMatch(#"^Webex\s*[-–—]\s*.{3,80}$"#, line) { return true }
    if regexMatch(#"^Whereby\s*[-–—]\s*.{3,80}$"#, line) { return true }
    if regexMatch(#"^Around\s*[-–—]\s*.{3,80}$"#, line) { return true }
  }
  return false
}

func hasMeetingUiText(_ text: String) -> Bool {
  regexMatch(#"(join now|leave call|leave meeting|meeting details|present now|captions|participants|people|raise hand|camera is starting|other ways to join|use gemini to take notes|share notes and transcript|waiting room|join with computer audio)"#, text)
}

func regexMatch(_ pattern: String, _ text: String) -> Bool {
  text.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
}

func isExcluded(window: ActiveWindow, config: HelperConfig) -> Bool {
  let app = window.app.lowercased()
  let bundleId = window.bundleId.lowercased()
  for raw in config.excluded_apps ?? [] {
    let needle = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if needle.isEmpty { continue }
    if app.contains(needle) || bundleId.contains(needle) { return true }
  }
  guard let url = window.url else { return false }
  return (config.excluded_url_patterns ?? []).contains { pattern in
    urlMatchesExcludedPattern(url, pattern: pattern)
  }
}

func urlMatchesExcludedPattern(_ rawUrl: String, pattern rawPattern: String) -> Bool {
  let pattern = rawPattern.trimmingCharacters(in: .whitespacesAndNewlines)
  if pattern.isEmpty { return false }
  if wildcardMatch(rawUrl, pattern: pattern) { return true }
  guard let parsed = URL(string: rawUrl) else { return false }

  var candidates = [parsed.absoluteString]
  if let host = parsed.host {
    let normalizedHost = stripWww(host)
    let hostWithPort = parsed.port.map { "\(host):\($0)" } ?? host
    let normalizedHostWithPort = stripWww(hostWithPort)
    let queryPart = parsed.query.map { "?\($0)" } ?? ""
    let fragmentPart = parsed.fragment.map { "#\($0)" } ?? ""
    let pathAndQuery = "\(parsed.path)\(queryPart)\(fragmentPart)"
    candidates.append(host)
    candidates.append(normalizedHost)
    candidates.append(hostWithPort)
    candidates.append(normalizedHostWithPort)
    candidates.append("\(normalizedHost)\(pathAndQuery)")
    candidates.append("\(normalizedHostWithPort)\(pathAndQuery)")
  }

  if candidates.contains(where: { wildcardMatch($0, pattern: pattern) }) {
    return true
  }

  guard isBareHostPattern(pattern),
        let patternHost = hostFromPattern(pattern),
        let urlHost = parsed.host.map(stripWww) else {
    return false
  }
  return urlHost == patternHost || urlHost.hasSuffix(".\(patternHost)")
}

func wildcardMatch(_ haystack: String, pattern: String) -> Bool {
  let escaped = NSRegularExpression
    .escapedPattern(for: pattern)
    .replacingOccurrences(of: "\\*", with: ".*")
  return haystack.range(
    of: "^\(escaped)$",
    options: [.regularExpression, .caseInsensitive]
  ) != nil
}

func isBareHostPattern(_ pattern: String) -> Bool {
  let value = pattern
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .replacingOccurrences(of: #"^https?://"#, with: "", options: .regularExpression)
  return !value.isEmpty && value.range(of: #"[/?#*:]"#, options: .regularExpression) == nil
}

func hostFromPattern(_ pattern: String) -> String? {
  let raw = pattern.trimmingCharacters(in: .whitespacesAndNewlines)
  let value = raw.contains("://") ? raw : "https://\(raw)"
  return URL(string: value).flatMap { $0.host }.map(stripWww)
}

func stripWww(_ value: String) -> String {
  value.lowercased().replacingOccurrences(of: #"^www\."#, with: "", options: .regularExpression)
}

func captureScreenshots(
  trigger: String,
  window: ActiveWindow,
  sessionId: String,
  displays: [DisplayInfo],
  config: HelperConfig
) -> Bool {
  let targets = displaysForScreenshot(window: window, selected: displays, config: config)
  var sawMeeting = liveMeetingEvidence(window: window, text: nil)
  for display in targets {
    if let asset = captureScreenshot(display: display, appName: window.app, config: config) {
      let ax = accessibilityText(window: window, config: config)
      let combinedText = [asset.visionText, ax?.text].compactMap { $0 }.joined(separator: "\n")
      let meetingEvidence = liveMeetingEvidence(window: window, text: combinedText)
      if meetingEvidence {
        sawMeeting = true
      }
      var metadata: [String: Any] = [
        "trigger": trigger,
        "source": "native-macos",
        "bytes": asset.bytes,
        "display_id": display.index,
        "display_name": display.name,
        "native_capture_method": "screencapture",
        "requested_format": config.screenshot_format ?? "webp",
        "actual_format": asset.actualFormat ?? "jpeg",
        "postprocessed_by": "capture-native-helper"
      ]
      if meetingEvidence {
        metadata["meeting_evidence"] = true
      }
      if let phash = asset.perceptualHash, !phash.isEmpty {
        metadata["perceptual_hash"] = phash
      }
      if let ocrText = asset.visionText, !ocrText.isEmpty {
        metadata["vision_text"] = ocrText
        metadata["vision_text_chars"] = ocrText.count
        if let d = asset.visionDurationMs { metadata["vision_text_duration_ms"] = d }
        metadata["vision_engine"] = "apple-vision"
      }
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
  return sawMeeting
}

struct ScreenshotAsset {
  let relativePath: String
  let bytes: Int
  // Optional fields populated when the native helper does the
  // resize/encode + perceptual-hash + OCR itself, so the Node side
  // can skip its sharp re-encode and Tesseract worker.
  let perceptualHash: String?
  let actualFormat: String?
  let visionText: String?
  let visionDurationMs: Int?
}

/// Decode a JPEG file into a CGImage, optionally downsizing during
/// decode via ImageIO's thumbnail path. ImageIO's thumbnail decoder is
/// significantly faster than decoding the full image and resampling
/// because it can skip JPEG MCUs above the target size, and on Apple
/// Silicon the resample step uses Accelerate.
func decodeJpeg(at path: String, maxDim: Int) -> CGImage? {
  let url = URL(fileURLWithPath: path)
  guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
  if maxDim > 0 {
    let opts: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceShouldCacheImmediately: true,
      kCGImageSourceThumbnailMaxPixelSize: maxDim
    ]
    return CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary)
  }
  return CGImageSourceCreateImageAtIndex(src, 0, nil)
}

/// Encode a CGImage as JPEG via ImageIO at the given quality (0.0–1.0).
func encodeJpeg(_ image: CGImage, to path: String, quality: Double) -> Bool {
  let url = URL(fileURLWithPath: path)
  guard let dest = CGImageDestinationCreateWithURL(
    url as CFURL,
    "public.jpeg" as CFString,
    1, nil
  ) else { return false }
  let q = max(0.0, min(1.0, quality))
  let opts: [CFString: Any] = [
    kCGImageDestinationLossyCompressionQuality: q
  ]
  CGImageDestinationAddImage(dest, image, opts as CFDictionary)
  return CGImageDestinationFinalize(dest)
}

/// 64-bit dHash, exactly matching the Sharp implementation in
/// plugins/capture/native/src/perceptual-hash.ts: resize to 9×8
/// grayscale, compare horizontal pairs, bit set when left < right,
/// row-major, then nibble-to-hex. The CGContext path on Apple Silicon
/// resamples via Accelerate and is dramatically cheaper than booting
/// a libvips pipeline for an 8×9 buffer.
func computeDHashHex(_ image: CGImage) -> String {
  let w = 9, h = 8
  var pixels = [UInt8](repeating: 0, count: w * h)
  let colorSpace = CGColorSpaceCreateDeviceGray()
  guard let ctx = CGContext(
    data: &pixels, width: w, height: h, bitsPerComponent: 8,
    bytesPerRow: w, space: colorSpace,
    bitmapInfo: CGImageAlphaInfo.none.rawValue
  ) else { return "" }
  ctx.interpolationQuality = .low
  ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))

  var bits = ""
  bits.reserveCapacity(64)
  for y in 0..<h {
    for x in 0..<8 {
      let left = pixels[y * w + x]
      let right = pixels[y * w + x + 1]
      bits.append(left < right ? "1" : "0")
    }
  }
  var hex = ""
  hex.reserveCapacity(16)
  var i = bits.startIndex
  while i < bits.endIndex {
    let end = bits.index(i, offsetBy: 4, limitedBy: bits.endIndex) ?? bits.endIndex
    if let n = Int(bits[i..<end], radix: 2) {
      hex.append(String(n, radix: 16))
    }
    i = end
  }
  return hex
}

/// Run Apple Vision text recognition over a CGImage. Returns
/// (text, durationMs) on success; nil when Vision is unavailable or
/// the image yields no text. Vision on Apple Silicon executes on the
/// Neural Engine, which is dramatically more power-efficient than
/// Tesseract WASM running on the Node main thread.
@available(macOS 13.0, *)
func recognizeVisionText(_ image: CGImage, languages: [String]?) -> (text: String, durationMs: Int)? {
  let started = Date()
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = .accurate
  req.usesLanguageCorrection = true
  if let langs = languages, !langs.isEmpty {
    req.recognitionLanguages = langs
  }
  let handler = VNImageRequestHandler(cgImage: image, options: [:])
  do {
    try handler.perform([req])
  } catch {
    return nil
  }
  guard let observations = req.results, !observations.isEmpty else {
    return nil
  }
  var lines: [String] = []
  lines.reserveCapacity(observations.count)
  for obs in observations {
    if let candidate = obs.topCandidates(1).first {
      lines.append(candidate.string)
    }
  }
  let text = lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
  if text.isEmpty { return nil }
  return (text, Int(Date().timeIntervalSince(started) * 1000))
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
  // Wrap the whole body in an autoreleasepool. This is a CLI binary
  // running `while true { Thread.sleep }`, not an NSApplication-based
  // app — there's no main runloop to drain the outer autorelease pool,
  // so every CF/NS object autoreleased downstream (CGImage backing
  // stores from decodeJpeg, CGImageDestination from encodeJpeg, the
  // VNImageRequestHandler + VNRecognizedTextObservation results from
  // recognizeVisionText, the Process/Pipe FileHandles for the
  // screencapture invocation, etc.) accumulates for the lifetime of
  // the process. Externally observed RSS climbed from ~16 MB at startup
  // to 300–400 MB after a few hours of normal capture activity. The
  // pool below drains once per screenshot tick (and once per display
  // when multi_screen is on), capping the steady-state RSS instead of
  // letting it grow with uptime.
  return autoreleasepool {
    let root = NSString(string: config.raw_root ?? NSHomeDirectory() + "/.beside").expandingTildeInPath
    let now = Date()
    let day = dayString(now)
    let time = timeString(now)
    let safeApp = safeFilename(appName)
    let suffix = display.index == 0 ? "" : "_s\(display.index)"

    // screencapture always produces JPEG. macOS's CGImageDestination
    // does not include a WebP encoder (only a decoder), so we cannot
    // produce a final-format `.webp` asset here without bundling
    // libwebp. We always write JPEG; the Node-side shim transcodes to
    // WebP when the user requested it. What we *can* skip on the Node
    // side: the Sharp dHash pass (we already emit a perceptual hash
    // here) and the Tesseract OCR worker (we attach Vision OCR text
    // here too).
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
        emit(["kind": "error", "code": "screenshot_failed",
              "message": "screencapture exited \(process.terminationStatus)"])
        return nil
      }
    } catch {
      emit(["kind": "error", "code": "screenshot_failed", "message": String(describing: error)])
      return nil
    }

    let maxDim = max(0, config.screenshot_max_dim ?? 0)
    let qualityRaw = max(1, min(100, config.screenshot_quality ?? 75))
    let quality = Double(qualityRaw) / 100.0

    // Decode the screencapture output once via ImageIO, optionally
    // downsizing during decode. We hand the same CGImage to dHash and
    // Vision so we don't pay the JPEG decode cost twice.
    let cgImage = decodeJpeg(at: abs, maxDim: maxDim)
    var phash: String? = nil
    var visionText: String? = nil
    var visionDurationMs: Int? = nil

    if let img = cgImage {
      phash = computeDHashHex(img)

      // Vision OCR: runs on the Neural Engine on Apple Silicon, where
      // it's dramatically more power-efficient than the Tesseract WASM
      // worker on the Node side. Frames carrying `vision_text` are
      // skipped by the OCR worker.
      if config.accessibility?.enabled != false, #available(macOS 13.0, *) {
        if let r = recognizeVisionText(img, languages: nil) {
          visionText = r.text
          visionDurationMs = r.durationMs
        }
      }

      // Re-encode JPEG via ImageIO so the on-disk asset reflects the
      // user-configured quality/maxDim. screencapture's default quality
      // is high (large files); ImageIO at the same source CGImage gives
      // us deterministic output with one decode and one encode.
      _ = encodeJpeg(img, to: abs, quality: quality)
    } else {
      emit(["kind": "log", "level": "warn",
            "message": "ImageIO could not decode screencapture output; emitting raw JPEG without phash/Vision",
            "data": ["path": abs]])
    }

    let attrs = (try? FileManager.default.attributesOfItem(atPath: abs)) ?? [:]
    let bytes = (attrs[.size] as? NSNumber)?.intValue ?? 0
    return ScreenshotAsset(
      relativePath: relative,
      bytes: bytes,
      perceptualHash: phash,
      actualFormat: "jpeg",
      visionText: visionText,
      visionDurationMs: visionDurationMs
    )
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

// Date formatters are non-trivial to allocate (locale + calendar setup)
// and were previously created on every event/screenshot. We memoize via
// `static let` inside an enum because top-level `let` initializers in a
// Swift script run in source order — and this file invokes
// `runMacCapture()` *before* the bottom-of-file declarations would have
// run. Static lets on a type are lazy and thread-safe, so they
// initialize on first access regardless of where they appear in the
// file.
enum DateFormatters {
  static let iso: ISO8601DateFormatter = ISO8601DateFormatter()
  static let day: DateFormatter = {
    let f = DateFormatter()
    f.calendar = Calendar(identifier: .gregorian)
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM-dd"
    return f
  }()
  static let time: DateFormatter = {
    let f = DateFormatter()
    f.calendar = Calendar(identifier: .gregorian)
    f.locale = Locale(identifier: "en_US_POSIX")
    // Include milliseconds so a hard-trigger screenshot and a
    // subsequent content_change probe in the same second never
    // collide. Collisions are dangerous because the TS shim may delete
    // low-diff soft-trigger assets after hashing.
    f.dateFormat = "HH-mm-ss-SSS"
    return f
  }()
}

func dayString(_ date: Date) -> String {
  return DateFormatters.day.string(from: date)
}

func timeString(_ date: Date) -> String {
  return DateFormatters.time.string(from: date)
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

// Per-pid cache of the last osascript-resolved URL keyed by window title.
// Browser windows update their title for every tab switch and almost
// every navigation, so a title-keyed cache eliminates the spawn on the
// "still reading the same page" path. The TTL backstop catches SPA
// route changes that don't update the title.
struct BrowserUrlCacheEntry {
  let title: String
  let url: String?
  let queriedAt: Date
}
var browserUrlCache: [pid_t: BrowserUrlCacheEntry] = [:]
let browserUrlBackstopTtl: TimeInterval = 30

func browserUrl(appName: String, pid: pid_t, title: String) -> String? {
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

  let now = Date()
  if let cached = browserUrlCache[pid],
     cached.title == title,
     now.timeIntervalSince(cached.queriedAt) < browserUrlBackstopTtl {
    return cached.url
  }

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
    let resolved = (out?.isEmpty == false) ? out : nil
    browserUrlCache[pid] = BrowserUrlCacheEntry(title: title, url: resolved, queriedAt: now)
    if browserUrlCache.count > 8 {
      let expired = browserUrlCache.compactMap { (p, e) in
        now.timeIntervalSince(e.queriedAt) > browserUrlBackstopTtl * 4 ? p : nil
      }
      for p in expired {
        browserUrlCache.removeValue(forKey: p)
      }
    }
    return resolved
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
  private let activation: String
  private let inboxPath: String
  private let partialPath: String
  private let chunkSeconds: TimeInterval
  private let pollInterval: TimeInterval
  private let sampleRate: Int
  private let channels: Int
  private let inputDetector = OtherProcessAudioInputDetector()
  private var recorder: AVAudioRecorder?
  private var currentStartedAt: Date?
  private var currentPartialURL: URL?
  private var currentFinalURL: URL?
  private var chunkIndex = 0
  private var prepared = false
  private var permissionDeniedLogged = false
  private var nextInputCheckAt = Date.distantPast

  init(config: HelperConfig) {
    let live = config.audio?.live_recording
    self.enabled = (config.capture_audio == true) && (live?.enabled == true)
    self.activation = live?.activation ?? "other_process_input"
    self.inboxPath = NSString(
      string: config.audio?.inbox_path ?? "~/.beside/raw/audio/inbox"
    ).expandingTildeInPath
    self.partialPath = (self.inboxPath as NSString).appendingPathComponent(".partial")
    self.chunkSeconds = TimeInterval(max(1, live?.chunk_seconds ?? 300))
    self.pollInterval = TimeInterval(max(1, live?.poll_interval_sec ?? 3))
    self.sampleRate = live?.sample_rate ?? 16_000
    self.channels = live?.channels ?? 1
  }

  func startIfEnabled() {
    guard enabled else { return }
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
      prepared = true
      emit([
        "kind": "log",
        "level": "info",
        "message": "native live audio chunking armed",
        "data": [
          "inbox_path": inboxPath,
          "chunk_seconds": chunkSeconds,
          "activation": activation,
          "poll_interval_sec": pollInterval,
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

  func tick(paused: Bool) {
    guard enabled, prepared else { return }
    if paused {
      stop()
      return
    }
    guard Date() >= nextInputCheckAt else {
      rotateIfNeeded()
      return
    }
    nextInputCheckAt = Date().addingTimeInterval(pollInterval)
    let shouldRecord = shouldRecordNow()
    if !shouldRecord {
      stop()
      return
    }
    if recorder == nil {
      startRecordingIfPossible()
      return
    }
    rotateIfNeeded()
  }

  func stop() {
    recorder?.stop()
    recorder = nil
    currentStartedAt = nil
    finalizeCurrentChunk()
  }

  private func rotateIfNeeded() {
    guard recorder != nil, let started = currentStartedAt else { return }
    if Date().timeIntervalSince(started) >= chunkSeconds {
      rotate()
    }
  }

  private func shouldRecordNow() -> Bool {
    switch activation {
    case "always", "other_process_input":
      return inputDetector.isOtherProcessUsingInput()
    default:
      emit([
        "kind": "error",
        "code": "audio_activation_unsupported",
        "message": "Unsupported live audio activation mode '\(activation)'; refusing to start microphone recording.",
        "fatal": false
      ])
      return false
    }
  }

  private func startRecordingIfPossible() {
    guard ensureMicrophonePermission() else {
      if !permissionDeniedLogged {
        permissionDeniedLogged = true
        emit([
          "kind": "error",
          "code": "audio_permission_denied",
          "message": "Native live audio recording is enabled but microphone permission is not granted.",
          "fatal": false
        ])
      }
      return
    }
    do {
      try startNewChunk()
      emit([
        "kind": "log",
        "level": "info",
        "message": "native live audio chunking started",
        "data": [
          "activation": activation,
          "chunk_seconds": chunkSeconds
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
        domain: "beside.audio",
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

final class OtherProcessAudioInputDetector {
  private let ownPid = getpid()
  private var unsupportedLogged = false

  func isOtherProcessUsingInput() -> Bool {
    guard #available(macOS 14.2, *) else {
      logUnsupported("CoreAudio per-process input activity requires macOS 14.2 or newer.")
      return false
    }
    do {
      return try isOtherProcessUsingInputModern()
    } catch {
      logUnsupported("CoreAudio per-process input activity probe failed: \(error)")
      return false
    }
  }

  @available(macOS 14.2, *)
  private func isOtherProcessUsingInputModern() throws -> Bool {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyProcessObjectList,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    let sizeStatus = AudioObjectGetPropertyDataSize(
      AudioObjectID(kAudioObjectSystemObject),
      &address,
      0,
      nil,
      &size
    )
    guard sizeStatus == noErr else {
      throw audioError("process list size", status: sizeStatus)
    }
    let count = Int(size) / MemoryLayout<AudioObjectID>.size
    if count == 0 { return false }

    var processes = Array(repeating: AudioObjectID(0), count: count)
    let listStatus = processes.withUnsafeMutableBufferPointer { buffer in
      AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject),
        &address,
        0,
        nil,
        &size,
        buffer.baseAddress!
      )
    }
    guard listStatus == noErr else {
      throw audioError("process list", status: listStatus)
    }

    for process in processes where process != AudioObjectID(0) {
      guard let pid = processPid(process), pid != ownPid else { continue }
      if processIsRunningInput(process) {
        return true
      }
    }
    return false
  }

  @available(macOS 14.2, *)
  private func processPid(_ process: AudioObjectID) -> pid_t? {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioProcessPropertyPID,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var pid = pid_t(0)
    var size = UInt32(MemoryLayout<pid_t>.size)
    let status = AudioObjectGetPropertyData(
      process,
      &address,
      0,
      nil,
      &size,
      &pid
    )
    return status == noErr ? pid : nil
  }

  @available(macOS 14.2, *)
  private func processIsRunningInput(_ process: AudioObjectID) -> Bool {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioProcessPropertyIsRunningInput,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var running: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    let status = AudioObjectGetPropertyData(
      process,
      &address,
      0,
      nil,
      &size,
      &running
    )
    return status == noErr && running != 0
  }

  private func logUnsupported(_ message: String) {
    guard !unsupportedLogged else { return }
    unsupportedLogged = true
    emit([
      "kind": "error",
      "code": "audio_activation_unavailable",
      "message": "\(message) Live microphone recording will stay off.",
      "fatal": false
    ])
  }
}

// MARK: - System audio capture (remote speakers via ScreenCaptureKit)

/// Wraps the availability-gated SystemAudioChunker behind plain closures so
/// runMacCapture can call tick/stop without sprinkling @available guards everywhere.
struct SystemAudioHandle {
  let tick: () -> Void
  let stop: () -> Void
}

func makeSystemAudioHandle(config: HelperConfig) -> SystemAudioHandle? {
  // Skip allocating a chunker entirely when live recording is off.
  // The chunkers' own `enabled` flag would already short-circuit
  // tick(), but constructing them still loads CoreAudio/ScreenCaptureKit
  // symbols, registers a DispatchQueue, and adds a non-nil handle that
  // gets ?.tick()'d every poll. Returning nil up front avoids all that.
  if config.audio?.live_recording?.enabled != true {
    return nil
  }
  let backend = config.audio?.live_recording?.system_audio_backend ?? "core_audio_tap"
  switch backend {
  case "off":
    emit(["kind": "log", "level": "info", "message": "system audio capture disabled"])
    return nil
  case "core_audio_tap":
    guard #available(macOS 14.2, *) else {
      emit(["kind": "log", "level": "warn",
            "message": "Core Audio system output capture requires macOS 14.2+; remote participant audio will stay off"])
      return nil
    }
    let chunker = CoreAudioSystemAudioChunker(config: config)
    chunker.startIfEnabled()
    return SystemAudioHandle(
      tick: { chunker.tick() },
      stop: { chunker.stop() }
    )
  case "screencapturekit":
    guard #available(macOS 13.0, *) else {
      emit(["kind": "log", "level": "info",
            "message": "ScreenCaptureKit system audio capture requires macOS 13.0+; skipping"])
      return nil
    }
    let chunker = SystemAudioChunker(config: config)
    chunker.startIfEnabled()
    return SystemAudioHandle(
      tick: { chunker.tick() },
      stop: { chunker.stop() }
    )
  default:
    emit(["kind": "error", "code": "system_audio_backend_unsupported",
          "message": "Unsupported system_audio_backend '\(backend)'; remote participant audio will stay off.",
          "fatal": false])
    return nil
  }
}

/// Captures system output audio using Core Audio process taps (macOS 14.2+).
/// Unlike ScreenCaptureKit, this is an audio-only API and does not open a
/// persistent screen-sharing stream.
@available(macOS 14.2, *)
final class CoreAudioSystemAudioChunker {
  private let enabled: Bool
  private let activation: String
  private let inboxPath: String
  private let partialPath: String
  private let chunkSeconds: TimeInterval
  private let pollInterval: TimeInterval
  private let inputDetector = OtherProcessAudioInputDetector()
  private let q = DispatchQueue(label: "beside.sysaudio.coreaudio", qos: .utility)

  private var processTapID = AudioObjectID(kAudioObjectUnknown)
  private var aggregateDeviceID = AudioObjectID(kAudioObjectUnknown)
  private var deviceProcID: AudioDeviceIOProcID?
  private var streamDescription: AudioStreamBasicDescription?
  private var audioFormat: AVAudioFormat?

  private var chunkIndex = 0
  private var currentFile: AVAudioFile?
  private var currentStartedAt: Date?
  private var currentPartialURL: URL?
  private var currentFinalURL: URL?
  private var currentHadSamples = false
  private var running = false
  private var prepared = false
  private var nextInputCheckAt = Date.distantPast

  init(config: HelperConfig) {
    let live = config.audio?.live_recording
    self.enabled = (config.capture_audio == true) && (live?.enabled == true)
    self.activation = live?.activation ?? "other_process_input"
    self.inboxPath = NSString(
      string: config.audio?.inbox_path ?? "~/.beside/raw/audio/inbox"
    ).expandingTildeInPath
    self.partialPath = (inboxPath as NSString).appendingPathComponent(".partial-coreaudio")
    self.chunkSeconds = TimeInterval(max(1, live?.chunk_seconds ?? 300))
    self.pollInterval = TimeInterval(max(1, live?.poll_interval_sec ?? 3))
  }

  func startIfEnabled() {
    guard enabled else { return }
    do {
      try FileManager.default.createDirectory(atPath: inboxPath, withIntermediateDirectories: true)
      try FileManager.default.createDirectory(atPath: partialPath, withIntermediateDirectories: true)
      reapStalePartials()
      prepared = true
      emit(["kind": "log", "level": "info",
            "message": "native Core Audio system output capture armed",
            "data": ["chunk_seconds": chunkSeconds, "backend": "core_audio_tap", "activation": activation]])
      tick()
    } catch {
      emit(["kind": "error", "code": "core_audio_tap_prepare_failed",
            "message": String(describing: error), "fatal": false])
    }
  }

  func tick() {
    guard enabled, prepared else { return }
    guard Date() >= nextInputCheckAt else {
      rotateIfNeeded()
      return
    }
    nextInputCheckAt = Date().addingTimeInterval(pollInterval)
    guard shouldRecordNow() else {
      stop()
      return
    }
    if !running {
      startCaptureIfNeeded()
      return
    }
    rotateIfNeeded()
  }

  private func startCaptureIfNeeded() {
    guard enabled, prepared, !running else { return }
    do {
      try prepareTap()
      try startNewChunk()
      try startDevice()
      running = true
      emit(["kind": "log", "level": "info",
            "message": "native Core Audio system output capture started",
            "data": ["chunk_seconds": chunkSeconds, "backend": "core_audio_tap"]])
    } catch {
      emit(["kind": "error", "code": "core_audio_tap_failed",
            "message": String(describing: error), "fatal": false])
      stop()
    }
  }

  private func rotateIfNeeded() {
    q.async { [weak self] in
      guard let self, self.running, let started = self.currentStartedAt else { return }
      if Date().timeIntervalSince(started) >= self.chunkSeconds {
        self.rotate()
      }
    }
  }

  private func shouldRecordNow() -> Bool {
    switch activation {
    case "always", "other_process_input":
      return inputDetector.isOtherProcessUsingInput()
    default:
      emit(["kind": "error", "code": "audio_activation_unsupported",
            "message": "Unsupported live audio activation mode '\(activation)'; refusing to start system output recording.",
            "fatal": false])
      return false
    }
  }

  func stop() {
    if aggregateDeviceID != AudioObjectID(kAudioObjectUnknown) {
      let stopStatus = AudioDeviceStop(aggregateDeviceID, deviceProcID)
      if stopStatus != noErr {
        emit(["kind": "log", "level": "warn",
              "message": "Core Audio tap device stop failed: \(stopStatus)"])
      }
      if let deviceProcID {
        let destroyProcStatus = AudioDeviceDestroyIOProcID(aggregateDeviceID, deviceProcID)
        if destroyProcStatus != noErr {
          emit(["kind": "log", "level": "warn",
                "message": "Core Audio tap IOProc destroy failed: \(destroyProcStatus)"])
        }
        self.deviceProcID = nil
      }
      let destroyAggregateStatus = AudioHardwareDestroyAggregateDevice(aggregateDeviceID)
      if destroyAggregateStatus != noErr {
        emit(["kind": "log", "level": "warn",
              "message": "Core Audio aggregate device destroy failed: \(destroyAggregateStatus)"])
      }
      aggregateDeviceID = AudioObjectID(kAudioObjectUnknown)
    }
    if processTapID != AudioObjectID(kAudioObjectUnknown) {
      let destroyTapStatus = AudioHardwareDestroyProcessTap(processTapID)
      if destroyTapStatus != noErr {
        emit(["kind": "log", "level": "warn",
              "message": "Core Audio process tap destroy failed: \(destroyTapStatus)"])
      }
      processTapID = AudioObjectID(kAudioObjectUnknown)
    }
    q.sync {
      finalizeCurrentChunk()
      running = false
    }
  }

  deinit {
    stop()
  }

  private func prepareTap() throws {
    let ownProcess = try? translatePidToAudioProcessObject(pid: getpid())
    let tapDescription = CATapDescription(
      stereoGlobalTapButExcludeProcesses: ownProcess.map { [$0] } ?? []
    )
    tapDescription.uuid = UUID()
    tapDescription.muteBehavior = .unmuted

    var tapID = AudioObjectID(kAudioObjectUnknown)
    var status = AudioHardwareCreateProcessTap(tapDescription, &tapID)
    guard status == noErr else {
      throw coreAudioError("AudioHardwareCreateProcessTap", status: status)
    }
    processTapID = tapID
    streamDescription = try readTapStreamDescription(tapID)
    guard var desc = streamDescription,
          let format = AVAudioFormat(streamDescription: &desc) else {
      throw coreAudioMessage("Core Audio tap did not expose a usable stream format")
    }
    audioFormat = format

    let outputDevice = try readDefaultSystemOutputDevice()
    let outputUID = try readDeviceUID(outputDevice)
    let aggregateUID = UUID().uuidString
    let aggregateDescription: [String: Any] = [
      kAudioAggregateDeviceNameKey: "Beside Core Audio Tap",
      kAudioAggregateDeviceUIDKey: aggregateUID,
      kAudioAggregateDeviceMainSubDeviceKey: outputUID,
      kAudioAggregateDeviceIsPrivateKey: true,
      kAudioAggregateDeviceIsStackedKey: false,
      kAudioAggregateDeviceTapAutoStartKey: true,
      kAudioAggregateDeviceSubDeviceListKey: [
        [kAudioSubDeviceUIDKey: outputUID]
      ],
      kAudioAggregateDeviceTapListKey: [
        [
          kAudioSubTapDriftCompensationKey: true,
          kAudioSubTapUIDKey: tapDescription.uuid.uuidString
        ]
      ]
    ]

    var aggregateID = AudioObjectID(kAudioObjectUnknown)
    status = AudioHardwareCreateAggregateDevice(aggregateDescription as CFDictionary, &aggregateID)
    guard status == noErr else {
      throw coreAudioError("AudioHardwareCreateAggregateDevice", status: status)
    }
    aggregateDeviceID = aggregateID
  }

  private func startDevice() throws {
    guard aggregateDeviceID != AudioObjectID(kAudioObjectUnknown),
          let format = audioFormat else {
      throw coreAudioMessage("Core Audio tap was not prepared")
    }
    var status = AudioDeviceCreateIOProcIDWithBlock(
      &deviceProcID,
      aggregateDeviceID,
      q
    ) { [weak self] _, inInputData, _, _, _ in
      guard let self, let file = self.currentFile else { return }
      guard let buffer = AVAudioPCMBuffer(
        pcmFormat: format,
        bufferListNoCopy: inInputData,
        deallocator: nil
      ) else { return }
      do {
        try file.write(from: buffer)
        self.currentHadSamples = true
      } catch {
        emit(["kind": "error", "code": "core_audio_tap_write_failed",
              "message": String(describing: error), "fatal": false])
      }
    }
    guard status == noErr else {
      throw coreAudioError("AudioDeviceCreateIOProcIDWithBlock", status: status)
    }

    status = AudioDeviceStart(aggregateDeviceID, deviceProcID)
    guard status == noErr else {
      throw coreAudioError("AudioDeviceStart", status: status)
    }
  }

  private func startNewChunk() throws {
    guard let format = audioFormat else {
      throw coreAudioMessage("Core Audio tap audio format is unavailable")
    }
    chunkIndex += 1
    let filename = "native-\(dayString(Date()))-\(timeString(Date()))-core-\(chunkIndex).wav"
    let partialURL = URL(fileURLWithPath: partialPath).appendingPathComponent(filename)
    let finalURL = URL(fileURLWithPath: inboxPath).appendingPathComponent(filename)
    let settings: [String: Any] = [
      AVFormatIDKey: Int(kAudioFormatLinearPCM),
      AVSampleRateKey: format.sampleRate,
      AVNumberOfChannelsKey: Int(format.channelCount),
      AVLinearPCMBitDepthKey: 32,
      AVLinearPCMIsFloatKey: true,
      AVLinearPCMIsBigEndianKey: false,
      AVLinearPCMIsNonInterleaved: !format.isInterleaved
    ]
    currentFile = try AVAudioFile(
      forWriting: partialURL,
      settings: settings,
      commonFormat: .pcmFormatFloat32,
      interleaved: format.isInterleaved
    )
    currentStartedAt = Date()
    currentPartialURL = partialURL
    currentFinalURL = finalURL
    currentHadSamples = false
  }

  private func rotate() {
    finalizeCurrentChunk()
    do {
      try startNewChunk()
    } catch {
      emit(["kind": "error", "code": "core_audio_tap_rotate_failed",
            "message": String(describing: error), "fatal": false])
    }
  }

  private func finalizeCurrentChunk() {
    currentFile = nil
    currentStartedAt = nil
    guard let partial = currentPartialURL, let final = currentFinalURL else { return }
    currentPartialURL = nil
    currentFinalURL = nil
    let fm = FileManager.default
    guard currentHadSamples, fm.fileExists(atPath: partial.path) else {
      try? fm.removeItem(at: partial)
      return
    }
    do {
      if fm.fileExists(atPath: final.path) {
        try fm.removeItem(at: final)
      }
      try fm.moveItem(at: partial, to: final)
    } catch {
      emit(["kind": "error", "code": "core_audio_tap_finalize_failed",
            "message": String(describing: error), "fatal": false])
    }
  }

  private func reapStalePartials() {
    let url = URL(fileURLWithPath: partialPath)
    let entries = (try? FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: nil)) ?? []
    for entry in entries {
      try? FileManager.default.removeItem(at: entry)
    }
    if !entries.isEmpty {
      emit(["kind": "log", "level": "warn",
            "message": "discarded stale Core Audio tap partials from previous run",
            "data": ["count": entries.count]])
    }
  }
}

/// Captures system audio output (remote meeting speakers) via SCStream and writes
/// 5-minute AAC chunks named `native-…-sys-N.m4a` into the same audio inbox as
/// the microphone chunker. The existing Whisper pipeline transcribes them and the
/// MeetingBuilder fuses them with screen frames by time overlap — no extra plumbing
/// needed. Requires macOS 13.0+ (SCStreamConfiguration.sampleRate / channelCount).
@available(macOS 13.0, *)
final class SystemAudioChunker: NSObject, SCStreamOutput, SCStreamDelegate {
  private let enabled: Bool
  private let activation: String
  private let inboxPath: String
  private let partialPath: String
  private let chunkSeconds: TimeInterval
  private let pollInterval: TimeInterval
  private let inputDetector = OtherProcessAudioInputDetector()

  private var stream: SCStream?
  // Serial queue owns all chunk state — SCStream audio callbacks are also
  // dispatched here so no extra locking is needed.
  private let q = DispatchQueue(label: "beside.sysaudio", qos: .utility)

  private var chunkIndex = 0
  private var capturing = false
  private var prepared = false
  private var sessionStarted = false
  private var nextInputCheckAt = Date.distantPast
  private var currentWriter: AVAssetWriter?
  private var currentInput: AVAssetWriterInput?
  private var currentStartedAt: Date?
  private var currentPartialURL: URL?
  private var currentFinalURL: URL?

  init(config: HelperConfig) {
    let live = config.audio?.live_recording
    self.enabled = (config.capture_audio == true) && (live?.enabled == true)
    self.activation = live?.activation ?? "other_process_input"
    self.inboxPath = NSString(
      string: config.audio?.inbox_path ?? "~/.beside/raw/audio/inbox"
    ).expandingTildeInPath
    self.partialPath = (inboxPath as NSString).appendingPathComponent(".partial-sys")
    self.chunkSeconds = TimeInterval(max(1, live?.chunk_seconds ?? 300))
    self.pollInterval = TimeInterval(max(1, live?.poll_interval_sec ?? 3))
  }

  func startIfEnabled() {
    guard enabled else { return }
    try? FileManager.default.createDirectory(atPath: inboxPath,  withIntermediateDirectories: true)
    try? FileManager.default.createDirectory(atPath: partialPath, withIntermediateDirectories: true)
    reapStalePartials()
    prepared = true
    emit(["kind": "log", "level": "info",
          "message": "native system audio capture armed",
          "data": ["chunk_seconds": chunkSeconds, "backend": "screencapturekit", "activation": activation]])
    tick()
  }

  func tick() {
    guard enabled, prepared else { return }
    guard Date() >= nextInputCheckAt else {
      rotateIfNeeded()
      return
    }
    nextInputCheckAt = Date().addingTimeInterval(pollInterval)
    guard shouldRecordNow() else {
      stop()
      return
    }
    if stream == nil {
      startStream()
      return
    }
    rotateIfNeeded()
  }

  private func rotateIfNeeded() {
    q.async { [weak self] in
      guard let self, self.capturing, let started = self.currentStartedAt else { return }
      if Date().timeIntervalSince(started) >= self.chunkSeconds { self.rotate() }
    }
  }

  private func shouldRecordNow() -> Bool {
    switch activation {
    case "always", "other_process_input":
      return inputDetector.isOtherProcessUsingInput()
    default:
      emit(["kind": "error", "code": "audio_activation_unsupported",
            "message": "Unsupported live audio activation mode '\(activation)'; refusing to start system output recording.",
            "fatal": false])
      return false
    }
  }

  func stop() {
    stream?.stopCapture(completionHandler: { _ in })
    stream = nil
    q.async { [weak self] in
      self?.finalizeCurrentChunk()
      self?.capturing = false
    }
  }

  // MARK: SCStreamOutput — invoked on `q`

  func stream(_ stream: SCStream,
              didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
              of outputType: SCStreamOutputType) {
    guard outputType == .audio, capturing,
          let input = currentInput, input.isReadyForMoreMediaData else { return }
    if !sessionStarted {
      currentWriter?.startSession(atSourceTime: sampleBuffer.presentationTimeStamp)
      sessionStarted = true
    }
    input.append(sampleBuffer)
  }

  // MARK: SCStreamDelegate

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    emit(["kind": "log", "level": "warn",
          "message": "system audio stream stopped: \(error.localizedDescription)"])
    q.async { self.capturing = false }
  }

  // MARK: Private

  private func startStream() {
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { [weak self] content, error in
      guard let self else { return }
      if let error {
        emit(["kind": "log", "level": "warn",
              "message": "system audio: SCShareableContent unavailable — \(error.localizedDescription)"])
        return
      }
      guard let display = content?.displays.first else {
        emit(["kind": "log", "level": "warn", "message": "system audio: no display found"])
        return
      }
      let cfg = SCStreamConfiguration()
      cfg.capturesAudio = true
      cfg.excludesCurrentProcessAudio = true
      cfg.sampleRate = 16_000
      cfg.channelCount = 1
      // Minimal video is required by SCStream even for audio-only capture.
      cfg.width = 2
      cfg.height = 2
      cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)
      cfg.queueDepth = 6

      let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
      let stream = SCStream(filter: filter, configuration: cfg, delegate: self)
      do {
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: self.q)
        stream.startCapture(completionHandler: { [weak self] error in
          guard let self else { return }
          if let error {
            emit(["kind": "log", "level": "warn",
                  "message": "system audio capture failed to start: \(error.localizedDescription)"])
            return
          }
          self.stream = stream
          self.q.async { self.startNewChunk() }
          emit(["kind": "log", "level": "info",
                "message": "native system audio capture started",
                "data": ["sample_rate": 16_000, "channels": 1, "chunk_seconds": self.chunkSeconds]])
        })
      } catch {
        emit(["kind": "log", "level": "warn",
              "message": "system audio capture setup failed: \(error.localizedDescription)"])
      }
    }
  }

  private func startNewChunk() {
    chunkIndex += 1
    let filename = "native-\(dayString(Date()))-\(timeString(Date()))-sys-\(chunkIndex).m4a"
    let partialURL = URL(fileURLWithPath: partialPath).appendingPathComponent(filename)
    let finalURL   = URL(fileURLWithPath: inboxPath).appendingPathComponent(filename)
    do {
      let writer = try AVAssetWriter(outputURL: partialURL, fileType: .m4a)
      let outputSettings: [String: Any] = [
        AVFormatIDKey:            Int(kAudioFormatMPEG4AAC),
        AVSampleRateKey:          16_000,
        AVNumberOfChannelsKey:    1,
        AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
      ]
      let input = AVAssetWriterInput(mediaType: .audio, outputSettings: outputSettings)
      input.expectsMediaDataInRealTime = true
      writer.add(input)
      writer.startWriting()
      currentWriter     = writer
      currentInput      = input
      currentStartedAt  = Date()
      currentPartialURL = partialURL
      currentFinalURL   = finalURL
      sessionStarted    = false
      capturing         = true
    } catch {
      emit(["kind": "error", "code": "sys_audio_chunk_start_failed",
            "message": String(describing: error), "fatal": false])
    }
  }

  private func rotate() {
    let snap = snapshotChunk()
    resetChunkState()
    startNewChunk()
    if let snap { finalizeSnapshot(snap) }
  }

  private func finalizeCurrentChunk() {
    if let snap = snapshotChunk() {
      resetChunkState()
      finalizeSnapshot(snap)
    }
  }

  private struct Snapshot {
    let writer: AVAssetWriter
    let input: AVAssetWriterInput
    let partialURL: URL
    let finalURL: URL
    let sessionStarted: Bool
  }

  private func snapshotChunk() -> Snapshot? {
    guard let w = currentWriter, let i = currentInput,
          let p = currentPartialURL, let f = currentFinalURL else { return nil }
    return Snapshot(writer: w, input: i, partialURL: p, finalURL: f, sessionStarted: sessionStarted)
  }

  private func resetChunkState() {
    currentWriter = nil; currentInput = nil
    currentStartedAt = nil; currentPartialURL = nil; currentFinalURL = nil
    sessionStarted = false
  }

  private func finalizeSnapshot(_ snap: Snapshot) {
    snap.input.markAsFinished()
    guard snap.sessionStarted else {
      // No audio received in this chunk (e.g. pure silence) — discard.
      try? FileManager.default.removeItem(at: snap.partialURL)
      return
    }
    snap.writer.finishWriting {
      guard snap.writer.status == .completed else {
        try? FileManager.default.removeItem(at: snap.partialURL)
        return
      }
      let fm = FileManager.default
      guard fm.fileExists(atPath: snap.partialURL.path) else { return }
      do {
        if fm.fileExists(atPath: snap.finalURL.path) { try? fm.removeItem(at: snap.finalURL) }
        try fm.moveItem(at: snap.partialURL, to: snap.finalURL)
      } catch {
        emit(["kind": "error", "code": "sys_audio_finalize_failed",
              "message": String(describing: error), "fatal": false])
      }
    }
  }

  private func reapStalePartials() {
    let url = URL(fileURLWithPath: partialPath)
    let entries = (try? FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: nil)) ?? []
    for e in entries { try? FileManager.default.removeItem(at: e) }
    if !entries.isEmpty {
      emit(["kind": "log", "level": "warn",
            "message": "discarded stale system audio partials from previous run",
            "data": ["count": entries.count]])
    }
  }
}

func audioError(_ operation: String, status: OSStatus) -> NSError {
  NSError(
    domain: "beside.audio.coreaudio",
    code: Int(status),
    userInfo: [NSLocalizedDescriptionKey: "\(operation) failed with OSStatus \(status)"]
  )
}

func coreAudioError(_ operation: String, status: OSStatus) -> NSError {
  NSError(
    domain: "beside.audio.coreaudio.tap",
    code: Int(status),
    userInfo: [NSLocalizedDescriptionKey: "\(operation) failed with OSStatus \(status)"]
  )
}

func coreAudioMessage(_ message: String) -> NSError {
  NSError(
    domain: "beside.audio.coreaudio.tap",
    code: 1,
    userInfo: [NSLocalizedDescriptionKey: message]
  )
}

@available(macOS 14.2, *)
func translatePidToAudioProcessObject(pid: pid_t) throws -> AudioObjectID {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  var inPid = pid
  var processObject = AudioObjectID(kAudioObjectUnknown)
  var size = UInt32(MemoryLayout<AudioObjectID>.size)
  let status = withUnsafeMutablePointer(to: &inPid) { pidPtr in
    AudioObjectGetPropertyData(
      AudioObjectID(kAudioObjectSystemObject),
      &address,
      UInt32(MemoryLayout<pid_t>.size),
      pidPtr,
      &size,
      &processObject
    )
  }
  guard status == noErr, processObject != AudioObjectID(kAudioObjectUnknown) else {
    throw coreAudioError("kAudioHardwarePropertyTranslatePIDToProcessObject", status: status)
  }
  return processObject
}

func readDefaultSystemOutputDevice() throws -> AudioDeviceID {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDefaultSystemOutputDevice,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  var device = AudioDeviceID(kAudioObjectUnknown)
  var size = UInt32(MemoryLayout<AudioDeviceID>.size)
  let status = AudioObjectGetPropertyData(
    AudioObjectID(kAudioObjectSystemObject),
    &address,
    0,
    nil,
    &size,
    &device
  )
  guard status == noErr, device != AudioDeviceID(kAudioObjectUnknown) else {
    throw coreAudioError("kAudioHardwarePropertyDefaultSystemOutputDevice", status: status)
  }
  return device
}

func readDeviceUID(_ device: AudioDeviceID) throws -> String {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioDevicePropertyDeviceUID,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  var uid = "" as CFString
  var size = UInt32(MemoryLayout<CFString>.size)
  let status = withUnsafeMutablePointer(to: &uid) { uidPtr in
    AudioObjectGetPropertyData(device, &address, 0, nil, &size, uidPtr)
  }
  guard status == noErr else {
    throw coreAudioError("kAudioDevicePropertyDeviceUID", status: status)
  }
  return uid as String
}

@available(macOS 14.2, *)
func readTapStreamDescription(_ tapID: AudioObjectID) throws -> AudioStreamBasicDescription {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioTapPropertyFormat,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  var desc = AudioStreamBasicDescription()
  var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
  let status = AudioObjectGetPropertyData(tapID, &address, 0, nil, &size, &desc)
  guard status == noErr else {
    throw coreAudioError("kAudioTapPropertyFormat", status: status)
  }
  return desc
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
