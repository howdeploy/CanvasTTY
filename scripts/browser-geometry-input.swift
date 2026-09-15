import Foundation
import CoreGraphics
guard ProcessInfo.processInfo.environment["CANVASTTY_GEOMETRY_DISPOSABLE_DESKTOP"] == "1",
      CommandLine.arguments.count == 5 else { exit(2) }
let values = CommandLine.arguments.dropFirst().compactMap(Double.init)
guard values.count == 4 else { exit(2) }
let start = CGPoint(x: values[0], y: values[1])
let end = CGPoint(x: values[2], y: values[3])
func post(_ type: CGEventType, _ point: CGPoint) {
    CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
}
post(.mouseMoved, start)
Thread.sleep(forTimeInterval: 0.08)
post(.leftMouseDown, start)
for step in 1...6 {
    Thread.sleep(forTimeInterval: 0.03)
    let fraction = Double(step) / 6
    post(.leftMouseDragged, CGPoint(x: start.x + (end.x - start.x) * fraction, y: start.y + (end.y - start.y) * fraction))
}
post(.leftMouseUp, end)
