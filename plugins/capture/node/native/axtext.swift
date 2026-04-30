// axtext — extract visible text from a macOS process via the
// Accessibility API. Built once during plugin build into
// `dist/native/axtext`, called by the Node capture plugin on every
// screenshot trigger.
//
// Usage:
//   axtext <pid> [maxChars] [maxElements] [deadlineMs]
//
// Output:
//   Plain UTF-8 text on stdout. Newline between elements. Empty stdout
//   if the app didn't expose anything useful (e.g. an Electron app with
//   AX disabled, or a fullscreen video player). Exit code is 0 on
//   success, 1 on AX permission denial, 2 on bad args.
//
// Why a native helper instead of osascript/AppleScript? Each element
// access in AppleScript is a synchronous Apple event round-trip; complex
// apps (Slack, Cursor) take 5-15s to walk. The same walk via direct
// AXUIElement APIs typically returns in <50ms because there's no
// scripting layer in between.

import Foundation
import ApplicationServices

let args = CommandLine.arguments
guard args.count >= 2, let pid = pid_t(args[1]) else {
    FileHandle.standardError.write("usage: axtext <pid> [maxChars] [maxElements] [deadlineMs]\n".data(using: .utf8)!)
    exit(2)
}
let maxChars: Int = args.count > 2 ? (Int(args[2]) ?? 8000) : 8000
let maxElements: Int = args.count > 3 ? (Int(args[3]) ?? 4000) : 4000
let deadlineMs: Int = args.count > 4 ? (Int(args[4]) ?? 1500) : 1500

// Permission check — calling AXIsProcessTrusted from a sandboxed binary
// always returns false, but our launcher is the user's terminal/agent
// process so this is a real signal. We don't gate on it (the API still
// works on systems where the prompt was accepted), but a clean error
// helps users diagnose first-run issues.

let app = AXUIElementCreateApplication(pid)
let deadline = Date().addingTimeInterval(Double(deadlineMs) / 1000.0)

// Focused window first; fall back to the first window if there's no
// focus (rare but happens immediately after spaces switch).
var rootRef: CFTypeRef?
var status = AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &rootRef)
if status != .success || rootRef == nil {
    status = AXUIElementCopyAttributeValue(app, kAXMainWindowAttribute as CFString, &rootRef)
}
if status != .success || rootRef == nil {
    var windowsRef: CFTypeRef?
    let s2 = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windowsRef)
    if s2 == .success, let arr = windowsRef as? [AXUIElement], let first = arr.first {
        rootRef = first as CFTypeRef
    }
}

// .apiDisabled = -25211 = the user has not granted Accessibility access.
if status == .apiDisabled || status == .notImplemented {
    FileHandle.standardError.write("ax permission denied\n".data(using: .utf8)!)
    exit(1)
}
guard let root = rootRef else {
    // No window exposed (e.g. menubar-only apps). Empty stdout, success.
    exit(0)
}

var output = ""
var elementCount = 0
// Note: we deliberately don't dedupe by identity. AXUIElement is a CF
// type and Swift's ObjectIdentifier on bridged CF refs isn't stable
// across copies — using it as a Set key produces false positives that
// silently prune most of the tree. The element budget + deadline are
// our only guards, which is fine because the AX tree is a DAG only on
// pathological apps and even those terminate quickly.

func stringAttr(_ elem: AXUIElement, _ attr: String) -> String? {
    var ref: CFTypeRef?
    let s = AXUIElementCopyAttributeValue(elem, attr as CFString, &ref)
    guard s == .success, let v = ref else { return nil }
    if let str = v as? String {
        return str.isEmpty ? nil : str
    }
    // Some attributes return an AXValue or NSNumber; try to coerce.
    if let num = v as? NSNumber {
        return num.stringValue
    }
    return nil
}

func childrenOf(_ elem: AXUIElement) -> [AXUIElement] {
    var ref: CFTypeRef?
    let s = AXUIElementCopyAttributeValue(elem, kAXChildrenAttribute as CFString, &ref)
    guard s == .success, let arr = ref as? [AXUIElement] else { return [] }
    return arr
}

func append(_ s: String) {
    if output.count + s.count + 1 > maxChars {
        let allowed = max(0, maxChars - output.count)
        if allowed > 0 {
            output += String(s.prefix(allowed))
        }
        return
    }
    output += s
    output += "\n"
}

// Iterative DFS with element budget + wall-clock deadline. Avoids
// blowing the Swift stack on deeply nested AX trees and lets us bail
// fast on apps with huge structures.
var stack: [AXUIElement] = [root as! AXUIElement]
while let elem = stack.popLast() {
    if output.count >= maxChars { break }
    if elementCount >= maxElements { break }
    if Date() >= deadline { break }
    elementCount += 1

    if let v = stringAttr(elem, kAXValueAttribute as String), v.count > 1 {
        append(v)
    }
    if let t = stringAttr(elem, kAXTitleAttribute as String), t.count > 1 {
        append(t)
    }
    if let d = stringAttr(elem, kAXDescriptionAttribute as String), d.count > 1 {
        append(d)
    }
    if let h = stringAttr(elem, kAXHelpAttribute as String), h.count > 4 {
        append(h)
    }
    if let p = stringAttr(elem, kAXPlaceholderValueAttribute as String), p.count > 1 {
        append(p)
    }

    // Push children in reverse so DFS matches visual top-to-bottom order.
    let kids = childrenOf(elem)
    if !kids.isEmpty {
        for k in kids.reversed() { stack.append(k) }
    }
}

if let data = output.data(using: .utf8) {
    FileHandle.standardOutput.write(data)
}
exit(0)
