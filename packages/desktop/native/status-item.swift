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

  private func makeImage(for _: CaptureState) -> NSImage {
    let size = NSSize(width: 18, height: 18)
    if
      let data = Data(base64Encoded: Self.mascotTemplatePngBase64),
      let image = NSImage(data: data)
    {
      image.size = size
      image.isTemplate = true
      return image
    }

    return Self.makeFallbackMascotImage(size: size)
  }

  private static let mascotTemplatePngBase64 = "iVBORw0KGgoAAAANSUhEUgAAACwAAAAsCAYAAAAehFoBAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAqklEQVR4nO3UywrAIAxE0fn/n56uhCCV+ojGKbngNj2ktkCWZauxOqEPZwfCBTw6pAVlx5wtYDpg2Zi1DO7dzgyUL/OW7+7MVlbQ9PjYToHp+Xf4eoVXYbEZyJ3gU3C5LVMJSg94FJYz6GgsR9DRSI6go3EcRUuBefF5LRrFBCPB+CW4mRS2JAO1yUBtMtA6OXCdFNYmB4YatiQHhiIYalibFLYkhc0yHO4BVkKufK+50CoAAAAASUVORK5CYII="

  private static func makeFallbackMascotImage(size: NSSize) -> NSImage {
    let image = NSImage(size: size)
    image.lockFocus()
    NSColor.black.setFill()
    NSColor.black.setStroke()

    let body = NSBezierPath()
    body.move(to: NSPoint(x: 1.4, y: 6.6))
    body.curve(
      to: NSPoint(x: 4.8, y: 12.6),
      controlPoint1: NSPoint(x: 1.4, y: 9.2),
      controlPoint2: NSPoint(x: 2.8, y: 11.5)
    )
    body.curve(
      to: NSPoint(x: 8.9, y: 14.3),
      controlPoint1: NSPoint(x: 6.1, y: 13.8),
      controlPoint2: NSPoint(x: 7.6, y: 14.7)
    )
    body.curve(
      to: NSPoint(x: 14.7, y: 11.1),
      controlPoint1: NSPoint(x: 11.2, y: 14.5),
      controlPoint2: NSPoint(x: 13.1, y: 12.7)
    )
    body.curve(
      to: NSPoint(x: 16.7, y: 7.8),
      controlPoint1: NSPoint(x: 16.1, y: 10.5),
      controlPoint2: NSPoint(x: 16.9, y: 9.1)
    )
    body.curve(
      to: NSPoint(x: 14.6, y: 6.4),
      controlPoint1: NSPoint(x: 16.6, y: 6.9),
      controlPoint2: NSPoint(x: 15.6, y: 6.5)
    )
    body.curve(
      to: NSPoint(x: 12.7, y: 2.8),
      controlPoint1: NSPoint(x: 14.4, y: 5.0),
      controlPoint2: NSPoint(x: 14.0, y: 3.8)
    )
    body.curve(
      to: NSPoint(x: 9.1, y: 1.2),
      controlPoint1: NSPoint(x: 11.6, y: 1.9),
      controlPoint2: NSPoint(x: 10.2, y: 1.0)
    )
    body.curve(
      to: NSPoint(x: 6.1, y: 3.1),
      controlPoint1: NSPoint(x: 7.9, y: 1.5),
      controlPoint2: NSPoint(x: 7.1, y: 2.5)
    )
    body.curve(
      to: NSPoint(x: 2.5, y: 4.2),
      controlPoint1: NSPoint(x: 4.7, y: 3.8),
      controlPoint2: NSPoint(x: 3.3, y: 3.4)
    )
    body.curve(
      to: NSPoint(x: 1.4, y: 6.6),
      controlPoint1: NSPoint(x: 1.8, y: 4.8),
      controlPoint2: NSPoint(x: 1.4, y: 5.6)
    )
    body.close()
    body.fill()

    let leftStem = NSBezierPath()
    leftStem.move(to: NSPoint(x: 4.9, y: 12.5))
    leftStem.line(to: NSPoint(x: 3.4, y: 15.4))
    leftStem.lineWidth = 0.9
    leftStem.lineCapStyle = .round
    leftStem.stroke()

    let rightStem = NSBezierPath()
    rightStem.move(to: NSPoint(x: 13.1, y: 12.5))
    rightStem.line(to: NSPoint(x: 14.7, y: 15.5))
    rightStem.lineWidth = 0.9
    rightStem.lineCapStyle = .round
    rightStem.stroke()

    NSBezierPath(ovalIn: NSRect(x: 2.2, y: 14.6, width: 2.4, height: 2.4)).fill()
    NSBezierPath(ovalIn: NSRect(x: 13.6, y: 14.7, width: 2.5, height: 2.5)).fill()

    image.unlockFocus()
    image.isTemplate = true
    return image
  }
}

let app = NSApplication.shared
let delegate = StatusApp()
app.delegate = delegate
app.run()
