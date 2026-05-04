import AppKit
import Foundation

private enum CaptureState: String {
  case capturing
  case paused
  case stopped

  var buttonTitle: String {
    switch self {
    case .capturing:
      return "CO CAP"
    case .paused:
      return "CO PAUSE"
    case .stopped:
      return "CO STOP"
    }
  }

  var statusTitle: String {
    switch self {
    case .capturing:
      return "CofounderOS - capturing"
    case .paused:
      return "CofounderOS - capture paused"
    case .stopped:
      return "CofounderOS - stopped"
    }
  }
}

final class StatusApp: NSObject, NSApplicationDelegate {
  private var item: NSStatusItem!
  private var statusMenuItem: NSMenuItem!
  private var state: CaptureState = .stopped

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)

    item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    if let button = item.button {
      button.title = state.buttonTitle
      button.toolTip = state.statusTitle
      button.image = makeImage(for: state)
      button.imagePosition = .imageLeft
    }

    let menu = NSMenu()
    statusMenuItem = NSMenuItem(title: state.statusTitle, action: nil, keyEquivalent: "")
    menu.addItem(statusMenuItem)
    menu.addItem(NSMenuItem.separator())
    menu.addItem(NSMenuItem(title: "Show Status", action: #selector(showStatus), keyEquivalent: "s"))
    menu.addItem(NSMenuItem(title: "Refresh", action: #selector(showStatus), keyEquivalent: "r"))
    menu.addItem(NSMenuItem.separator())
    menu.addItem(NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q"))
    item.menu = menu

    startInputLoop()
    emit(["kind": "ready"])
  }

  @objc private func showStatus() {
    emit(["kind": "show-status"])
  }

  @objc private func quit() {
    emit(["kind": "quit"])
  }

  private func emit(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj),
       let line = String(data: data, encoding: .utf8) {
      print(line)
      fflush(stdout)
    }
  }

  private func startInputLoop() {
    DispatchQueue.global(qos: .utility).async { [weak self] in
      while let line = readLine(strippingNewline: true) {
        self?.handleInput(line)
      }
    }
  }

  private func handleInput(_ line: String) {
    guard
      let data = line.data(using: .utf8),
      let decoded = try? JSONSerialization.jsonObject(with: data),
      let obj = decoded as? [String: Any],
      obj["kind"] as? String == "set-state",
      let stateName = obj["state"] as? String,
      let nextState = CaptureState(rawValue: stateName)
    else {
      return
    }
    let label = obj["label"] as? String
    DispatchQueue.main.async { [weak self] in
      self?.updateState(nextState, label: label)
    }
  }

  private func updateState(_ nextState: CaptureState, label: String?) {
    state = nextState
    let title = label ?? nextState.statusTitle
    statusMenuItem.title = title
    if let button = item.button {
      button.title = nextState.buttonTitle
      button.toolTip = title
      button.image = makeImage(for: nextState)
      button.imagePosition = .imageLeft
    }
  }

  private func makeImage(for state: CaptureState) -> NSImage {
    let size = NSSize(width: 18, height: 18)
    let image = NSImage(size: size)
    image.lockFocus()
    NSColor.black.setFill()
    switch state {
    case .capturing:
      NSBezierPath(ovalIn: NSRect(x: 5, y: 5, width: 8, height: 8)).fill()
    case .paused:
      NSBezierPath(roundedRect: NSRect(x: 5, y: 4, width: 3, height: 10), xRadius: 1.5, yRadius: 1.5).fill()
      NSBezierPath(roundedRect: NSRect(x: 10, y: 4, width: 3, height: 10), xRadius: 1.5, yRadius: 1.5).fill()
    case .stopped:
      NSBezierPath(roundedRect: NSRect(x: 5, y: 5, width: 8, height: 8), xRadius: 1.5, yRadius: 1.5).fill()
    }
    image.unlockFocus()
    image.isTemplate = true
    return image
  }
}

let app = NSApplication.shared
let delegate = StatusApp()
app.delegate = delegate
app.run()
