import Foundation
import CoreGraphics
guard ProcessInfo.processInfo.environment["CANVASTTY_GEOMETRY_DISPOSABLE_DESKTOP"] == "1",
      CommandLine.arguments.count == 6 else { exit(2) }
let operation = CommandLine.arguments[1]
let values = CommandLine.arguments.dropFirst(2).compactMap(Double.init)
guard values.count == 4 else { exit(2) }
let start = CGPoint(x: values[0], y: values[1])
let end = CGPoint(x: values[2], y: values[3])
func post(_ type: CGEventType, _ point: CGPoint) {
    let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left)
    if operation == "alt-drag" { event?.flags = .maskAlternate }
    event?.post(tap: .cghidEventTap)
}
post(.mouseMoved, start)
Thread.sleep(forTimeInterval: 0.08)
if operation == "scroll" {
    for _ in 1...3 {
        CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: -60, wheel2: 0, wheel3: 0)?.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.04)
    }
    exit(0)
}
if operation == "alt-drag" {
    let key = CGEvent(keyboardEventSource: nil, virtualKey: 58, keyDown: true)
    key?.flags = .maskAlternate
    key?.post(tap: .cghidEventTap)
}
post(.leftMouseDown, start)
for step in 1...6 {
    Thread.sleep(forTimeInterval: 0.03)
    let fraction = Double(step) / 6
    post(.leftMouseDragged, CGPoint(x: start.x + (end.x - start.x) * fraction, y: start.y + (end.y - start.y) * fraction))
}
post(.leftMouseUp, end)
if operation == "alt-drag" { CGEvent(keyboardEventSource: nil, virtualKey: 58, keyDown: false)?.post(tap: .cghidEventTap) }
