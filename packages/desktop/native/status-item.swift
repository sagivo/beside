import AppKit
import Foundation

private enum CaptureState: String {
  case capturing
  case paused
  case stopped

  var statusTitle: String {
    switch self {
    case .capturing:
      return "Beside - capturing"
    case .paused:
      return "Beside - capture paused"
    case .stopped:
      return "Beside - stopped"
    }
  }
}

final class StatusApp: NSObject, NSApplicationDelegate {
  private var item: NSStatusItem!
  private var statusMenuItem: NSMenuItem!
  private var state: CaptureState = .stopped

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)

    item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    if let button = item.button {
      button.title = ""
      button.toolTip = state.statusTitle
      button.image = makeImage(for: state)
      button.imagePosition = .imageOnly
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
      button.title = ""
      button.toolTip = title
      button.image = makeImage(for: nextState)
      button.imagePosition = .imageOnly
    }
  }

  private func makeImage(for state: CaptureState) -> NSImage {
    let size = NSSize(width: 18, height: 18)
    let image = NSImage(size: size)
    image.lockFocus()
    NSColor.black.setFill()

    // Two stacked blobs echoing the Beside app logo (figure-8 silhouette).
    let cx: CGFloat = 9
    let radius: CGFloat = 4.6
    let topCy: CGFloat = 12.4
    let bottomCy: CGFloat = 5.6

    let top = NSBezierPath(ovalIn: NSRect(
      x: cx - radius, y: topCy - radius, width: radius * 2, height: radius * 2
    ))
    let bottom = NSBezierPath(ovalIn: NSRect(
      x: cx - radius, y: bottomCy - radius, width: radius * 2, height: radius * 2
    ))
    top.fill()
    bottom.fill()

    image.unlockFocus()
    image.isTemplate = true
    return image
  }
}

let app = NSApplication.shared
let delegate = StatusApp()
app.delegate = delegate
app.run()
