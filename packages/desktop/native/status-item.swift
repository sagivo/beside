import AppKit
import Foundation

final class StatusApp: NSObject, NSApplicationDelegate {
  private var item: NSStatusItem!

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)

    item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    if let button = item.button {
      button.title = "CO"
      button.toolTip = "CofounderOS"
      button.image = makeImage()
      button.imagePosition = .imageLeft
    }

    let menu = NSMenu()
    menu.addItem(NSMenuItem(title: "CofounderOS", action: nil, keyEquivalent: ""))
    menu.addItem(NSMenuItem.separator())
    menu.addItem(NSMenuItem(title: "Show Status", action: #selector(showStatus), keyEquivalent: "s"))
    menu.addItem(NSMenuItem(title: "Refresh", action: #selector(showStatus), keyEquivalent: "r"))
    menu.addItem(NSMenuItem.separator())
    menu.addItem(NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q"))
    item.menu = menu

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

  private func makeImage() -> NSImage {
    let size = NSSize(width: 18, height: 18)
    let image = NSImage(size: size)
    image.lockFocus()
    NSColor.black.setFill()
    let rect = NSRect(x: 2, y: 2, width: 14, height: 14)
    NSBezierPath(roundedRect: rect, xRadius: 4, yRadius: 4).fill()
    NSColor.white.setFill()
    NSBezierPath(ovalIn: NSRect(x: 7, y: 7, width: 4, height: 4)).fill()
    image.unlockFocus()
    image.isTemplate = true
    return image
  }
}

let app = NSApplication.shared
let delegate = StatusApp()
app.delegate = delegate
app.run()
