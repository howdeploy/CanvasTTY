#!/usr/bin/env python3
"""X11 window hosting over bounded NDJSON; no external Python packages."""
import ctypes as C
import json
import math
import os
from pathlib import Path
import selectors
import signal
import sys
import time

U = C.c_ulong
I = C.c_int
P = C.c_void_p


class Attributes(C.Structure):
    _fields_ = [
        ("x", I), ("y", I), ("width", I), ("height", I), ("border_width", I),
        ("depth", I), ("visual", P), ("root", U), ("window_class", I),
        ("bit_gravity", I), ("win_gravity", I), ("backing_store", I),
        ("backing_planes", U), ("backing_pixel", U), ("save_under", I),
        ("colormap", U), ("map_installed", I), ("map_state", I),
        ("all_event_masks", C.c_long), ("your_event_mask", C.c_long),
        ("do_not_propagate_mask", C.c_long), ("override_redirect", I), ("screen", P),
    ]


class Error(C.Structure):
    _fields_ = [("type", I), ("display", P), ("resourceid", U), ("serial", U),
                ("error_code", C.c_ubyte), ("request_code", C.c_ubyte), ("minor_code", C.c_ubyte)]


class Rectangle(C.Structure):
    _fields_ = [("x", C.c_short), ("y", C.c_short), ("width", C.c_ushort), ("height", C.c_ushort)]


def process_identity(pid):
    directory = Path("/proc") / str(pid)
    if pid <= 1 or directory.stat().st_uid != os.getuid():
        raise ValueError("Only local windows belonging to your user may be embedded.")
    # The command name can itself contain spaces and parentheses.
    return (directory / "stat").read_text().rsplit(")", 1)[1].split()[19]


class Host:
    def __init__(self, owner_pid, parent):
        self.owner_pid, self.parent = owner_pid, parent
        self.owner_identity = process_identity(owner_pid)
        self.attached = {}
        self.placement_errors = {}
        self.errors = []
        self.button_down = False
        self.x = C.CDLL("libX11.so.6")
        self.fixes = C.CDLL("libXfixes.so.3")
        signatures = {
            "XOpenDisplay": (P, [C.c_char_p]), "XCloseDisplay": (I, [P]),
            "XDefaultRootWindow": (U, [P]), "XSync": (I, [P, I]),
            "XInternAtom": (U, [P, C.c_char_p, I]), "XFree": (I, [P]),
            "XGetWindowAttributes": (I, [P, U, C.POINTER(Attributes)]),
            "XQueryTree": (I, [P, U, C.POINTER(U), C.POINTER(U), C.POINTER(C.POINTER(U)), C.POINTER(C.c_uint)]),
            "XGetWindowProperty": (I, [P, U, U, C.c_long, C.c_long, I, U, C.POINTER(U), C.POINTER(I), C.POINTER(U), C.POINTER(U), C.POINTER(P)]),
            "XChangeProperty": (I, [P, U, U, U, I, I, P, I]),
            "XDeleteProperty": (I, [P, U, U]),
            "XTranslateCoordinates": (I, [P, U, U, I, I, C.POINTER(I), C.POINTER(I), C.POINTER(U)]),
            "XCreateSimpleWindow": (U, [P, U, I, I, C.c_uint, C.c_uint, C.c_uint, U, U]),
            "XReparentWindow": (I, [P, U, U, I, I]),
            "XMoveResizeWindow": (I, [P, U, I, I, C.c_uint, C.c_uint]),
            "XSetWindowBorderWidth": (I, [P, U, C.c_uint]),
            "XMapWindow": (I, [P, U]), "XUnmapWindow": (I, [P, U]),
            "XRaiseWindow": (I, [P, U]),
            "XDestroyWindow": (I, [P, U]),
            "XQueryPointer": (I, [P, U, C.POINTER(U), C.POINTER(U), C.POINTER(I), C.POINTER(I), C.POINTER(I), C.POINTER(I), C.POINTER(C.c_uint)]),
            "XSetInputFocus": (I, [P, U, I, U]),
        }
        for name, (result, arguments) in signatures.items():
            function = getattr(self.x, name)
            function.restype, function.argtypes = result, arguments
        self.fixes.XFixesQueryVersion.argtypes = [P, C.POINTER(I), C.POINTER(I)]
        self.fixes.XFixesQueryVersion.restype = I
        self.fixes.XFixesChangeSaveSet.argtypes = [P, U, I, I, I]
        self.fixes.XFixesChangeSaveSet.restype = None
        for name, result, arguments in [
            ("XFixesCreateRegion", U, [P, C.POINTER(Rectangle), I]),
            ("XFixesDestroyRegion", None, [P, U]),
            ("XFixesSubtractRegion", None, [P, U, U, U]),
            ("XFixesSetWindowShapeRegion", None, [P, U, I, I, I, U]),
        ]:
            function = getattr(self.fixes, name)
            function.restype, function.argtypes = result, arguments
        self.error_handler = C.CFUNCTYPE(I, P, C.POINTER(Error))(self.on_error)
        self.x.XSetErrorHandler.argtypes = [type(self.error_handler)]
        self.x.XSetErrorHandler.restype = P
        self.x.XSetErrorHandler(self.error_handler)
        self.display = self.x.XOpenDisplay(None)
        if not self.display:
            raise RuntimeError("Cannot open DISPLAY. Linux desktop embedding requires X11 or XWayland.")
        self.root = self.x.XDefaultRootWindow(self.display)
        major, minor = I(2), I(0)
        if not self.fixes.XFixesQueryVersion(self.display, C.byref(major), C.byref(minor)) or major.value < 2:
            raise RuntimeError("The X11 server needs XFixes 2 for desktop clipping and safe window recovery.")
        self.attributes(parent)
        if self.pid(parent) != owner_pid:
            raise RuntimeError("CanvasTTY must run on X11/XWayland. Restart it with --ozone-platform=x11.")

    def on_error(self, _display, event):
        self.errors.append(event.contents.error_code)
        return 0

    def sync(self):
        self.x.XSync(self.display, 0)
        if self.errors:
            codes, self.errors = self.errors, []
            raise RuntimeError("X11 refused the window operation (errors: " + ", ".join(map(str, codes)) + ").")

    def atom(self, name):
        return self.x.XInternAtom(self.display, name.encode("ascii"), 0)

    def property(self, window, name):
        kind, count, remaining, data, form = U(), U(), U(), P(), I()
        status = self.x.XGetWindowProperty(self.display, window, self.atom(name), 0, 2048, 0, 0,
                                           C.byref(kind), C.byref(form), C.byref(count), C.byref(remaining), C.byref(data))
        try:
            self.sync()
            if status or not data or remaining.value:
                return 0, 0, None
            if form.value == 32:
                value = list(C.cast(data, C.POINTER(U))[:count.value])
            elif form.value == 8:
                value = C.string_at(data, count.value)
            else:
                return 0, 0, None
            return kind.value, form.value, value
        finally:
            if data:
                self.x.XFree(data)

    def restore_property(self, window, name, saved):
        kind, form, value = saved
        if value is None:
            self.x.XDeleteProperty(self.display, window, self.atom(name))
        else:
            data = (U * len(value))(*value) if form == 32 else C.create_string_buffer(value)
            self.x.XChangeProperty(self.display, window, self.atom(name), kind, form, 0, data, len(value))

    def attributes(self, window):
        if not isinstance(window, int) or not 0 < window <= 0xffffffff:
            raise ValueError("Invalid X11 window ID. CanvasTTY must run with --ozone-platform=x11.")
        attributes = Attributes()
        status = self.x.XGetWindowAttributes(self.display, window, C.byref(attributes))
        self.sync()
        if not status or attributes.root != self.root:
            raise ValueError("Window is no longer on this X11 display.")
        return attributes

    def children(self, window):
        root, parent, children, count = U(), U(), C.POINTER(U)(), C.c_uint()
        status = self.x.XQueryTree(self.display, window, C.byref(root), C.byref(parent), C.byref(children), C.byref(count))
        try:
            self.sync()
            if not status or count.value > 10000:
                return 0, []
            return parent.value, list(children[:count.value])
        finally:
            if children:
                self.x.XFree(children)

    def pid(self, window):
        value = self.property(window, "_NET_WM_PID")[2]
        return value[0] if isinstance(value, list) and len(value) == 1 else 0

    def position(self, window):
        x, y, child = I(), I(), U()
        status = self.x.XTranslateCoordinates(self.display, window, self.root, 0, 0, C.byref(x), C.byref(y), C.byref(child))
        self.sync()
        if not status:
            raise ValueError("Cannot determine the window position.")
        return x.value, y.value

    def candidates(self):
        windows = self.property(self.root, "_NET_CLIENT_LIST")[2]
        if not isinstance(windows, list):
            # Some XWayland window managers expose only their root children.
            _, windows = self.children(self.root)
        result = []
        for window in windows[:2000]:
            try:
                attributes = self.attributes(window)
                pid = self.pid(window)
                if pid == self.owner_pid or attributes.map_state != 2 or attributes.override_redirect:
                    continue
                process_identity(pid)
                if any(item["window"] == window for item in self.attached.values()):
                    continue
                if self.property(window, "WM_TRANSIENT_FOR")[2]:
                    continue
                kinds = self.property(window, "_NET_WM_WINDOW_TYPE")[2]
                if kinds and self.atom("_NET_WM_WINDOW_TYPE_NORMAL") not in kinds:
                    continue
                title = self.property(window, "_NET_WM_NAME")[2] or self.property(window, "WM_NAME")[2]
                if not isinstance(title, bytes) or not title:
                    continue
                process = (Path("/proc") / str(pid) / "comm").read_text().strip()
                result.append({"Handle": str(window), "Pid": pid, "Title": title.decode("utf-8", "replace")[:512], "Process": process[:128]})
            except (OSError, ValueError, RuntimeError):
                continue
            if len(result) >= 200:
                break
        return result

    def valid(self, item):
        try:
            return self.pid(item["window"]) == item["pid"] and process_identity(item["pid"]) == item["identity"]
        except (OSError, ValueError, RuntimeError):
            return False

    def attach(self, request):
        token, window, pid = request["token"], int(request["handle"]), request["pid"]
        if token in self.attached or len(self.attached) >= 8:
            raise ValueError("This card already has a window, or the eight-window limit was reached.")
        if int(request["parent"]) != self.parent or not any(
            item["Handle"] == str(window) and item["Pid"] == pid for item in self.candidates()
        ):
            raise ValueError("Window selection is no longer available. Refresh the list.")
        attributes = self.attributes(window)
        x, y = self.position(window)
        item = {"window": window, "pid": pid, "identity": process_identity(pid),
                "x": x, "y": y, "width": attributes.width, "height": attributes.height,
                "border": attributes.border_width, "visible": False,
                "properties": {name: self.property(window, name) for name in ("_NET_WM_STATE", "_NET_WM_DESKTOP")},
                "container": 0, "saved": False}
        self.attached[token] = item
        try:
            self.attributes(self.parent)
            # SaveSetRoot + SaveSetMap restores the client to the desktop even if
            # this helper dies while Electron and its child container are alive.
            self.fixes.XFixesChangeSaveSet(self.display, window, 0, 1, 0)
            self.sync()
            item["saved"] = True
            # Native parentage keeps the viewport inside CanvasTTY across monitor/window moves.
            # shortcut: SIGKILL of Electron can destroy foreign children; soft close restores them first.
            item["container"] = self.x.XCreateSimpleWindow(self.display, self.parent, 0, 0, 1, 1, 0, 0, 0)
            self.sync()
            if self.children(item["container"])[0] != self.parent:
                raise RuntimeError("The desktop viewport is not a native child of CanvasTTY.")
            self.x.XReparentWindow(self.display, window, item["container"], 0, 0)
            self.x.XSetWindowBorderWidth(self.display, window, 0)
            self.x.XMapWindow(self.display, window)
            self.sync()
        except Exception:
            self.detach(token)
            raise

    def update(self, request):
        failure = self.placement_errors.pop(request["token"], None)
        if failure:
            raise RuntimeError(failure)
        item = self.attached.get(request["token"])
        if not item or not self.valid(item):
            self.detach(request["token"])
            raise ValueError("Desktop window is no longer attached.")
        clip = request.get("clipBounds")
        if not isinstance(clip, dict):
            raise ValueError("Invalid X11 clipping bounds.")
        dimensions = [request[key] for key in ("x", "y", "width", "height", "referenceWidth", "referenceHeight")]
        dimensions += [clip[key] for key in ("x", "y", "width", "height")]
        if any(type(value) not in (int, float) or not math.isfinite(value) or abs(value) > 32768 for value in dimensions) or min(dimensions[2:4] + dimensions[8:10]) < 0 or min(dimensions[4:6]) < 1:
            raise ValueError("Invalid X11 viewport.")
        occlusions = request.get("occlusions")
        if not isinstance(occlusions, list) or len(occlusions) > 256:
            raise ValueError("Invalid X11 desktop occlusions.")
        rectangles = []
        for rectangle in occlusions:
            if not isinstance(rectangle, dict):
                raise ValueError("Invalid X11 desktop occlusion.")
            values = tuple(rectangle[key] for key in ("x", "y", "width", "height"))
            if any(type(value) not in (int, float) or not math.isfinite(value) or abs(value) > 32768 for value in values) or min(values[2:]) < 0:
                raise ValueError("Invalid X11 desktop occlusion.")
            rectangles.append(values)
        item["occlusions"] = rectangles
        item["viewport"] = (*dimensions, request.get("visible") is True)
        # Apply the latest rectangle once after draining input, like the browser viewport.

    def top_level(self):
        window = self.parent
        for _ in range(64):
            parent, _ = self.children(window)
            if parent == self.root:
                return window
            if not parent:
                break
            window = parent
        raise RuntimeError("CanvasTTY's X11 parent is unavailable.")

    def render(self, item, host):
        x, y, width, height, reference_width, reference_height, cx, cy, cw, ch, requested = item.get("viewport", (0, 0, 0, 0, 1, 1, 0, 0, 0, 0, False))
        # XWayland's native grid can differ from Electron's reported monitor DPI.
        x, y = round(x * host.width / reference_width), round(y * host.height / reference_height)
        width, height = round(width * host.width / reference_width), round(height * host.height / reference_height)
        left = max(0, x, math.ceil(cx * host.width / reference_width))
        top = max(0, y, math.ceil(cy * host.height / reference_height))
        right = min(host.width, x + width, math.floor((cx + cw) * host.width / reference_width))
        bottom = min(host.height, y + height, math.floor((cy + ch) * host.height / reference_height))
        visible = requested and host.map_state == 2 and right > left and bottom > top
        changed = False
        if visible:
            placement = (left, top, right - left, bottom - top)
            layout = (x - left, y - top, width, height)
            if placement != item.get("placement"):
                self.x.XMoveResizeWindow(self.display, item["container"], *placement)
                item["placement"] = placement
                changed = True
            if layout != item.get("layout"):
                self.x.XMoveResizeWindow(self.display, item["window"], *layout)
                item["layout"] = layout
                changed = True
            holes = []
            for ox, oy, ow, oh in item.get("occlusions", []):
                hl = max(left, math.floor(ox * host.width / reference_width))
                ht = max(top, math.floor(oy * host.height / reference_height))
                hr = min(right, math.ceil((ox + ow) * host.width / reference_width))
                hb = min(bottom, math.ceil((oy + oh) * host.height / reference_height))
                if hr > hl and hb > ht:
                    holes.append((hl - left, ht - top, hr - hl, hb - ht))
            shape = (right - left, bottom - top, tuple(holes))
            if shape != item.get("shape"):
                self.shape(item["container"], *shape)
                item["shape"] = shape
                changed = True
            if not item["visible"]:
                self.x.XMapWindow(self.display, item["window"])
                self.x.XMapWindow(self.display, item["container"])
                self.x.XRaiseWindow(self.display, item["container"])
                changed = True
        elif item["visible"]:
            self.x.XUnmapWindow(self.display, item["container"])
            changed = True
        if changed:
            self.sync()
        if visible:
            actual = self.attributes(item["container"])
            geometry = (actual.x, actual.y, actual.width, actual.height)
            if geometry != placement:
                since = item.setdefault("misplaced_since", time.monotonic())
                if time.monotonic() - since > 0.25:
                    raise RuntimeError(f"The native desktop viewport lost its CanvasTTY-relative bounds (expected {placement}, got {geometry}). The application was returned to the desktop.")
            else:
                item.pop("misplaced_since", None)
        else:
            item.pop("misplaced_since", None)
        item["visible"] = visible

    def shape(self, window, width, height, holes):
        rectangle = Rectangle(0, 0, width, height)
        region = self.fixes.XFixesCreateRegion(self.display, C.byref(rectangle), 1)
        excluded = 0
        try:
            if holes:
                rectangles = (Rectangle * len(holes))(*(Rectangle(*bounds) for bounds in holes))
                excluded = self.fixes.XFixesCreateRegion(self.display, rectangles, len(holes))
                self.fixes.XFixesSubtractRegion(self.display, region, region, excluded)
            # The same holes reveal the DOM HUD and route its pointer input to Electron.
            self.fixes.XFixesSetWindowShapeRegion(self.display, window, 0, 0, 0, region)
            self.fixes.XFixesSetWindowShapeRegion(self.display, window, 2, 0, 0, region)
        finally:
            if excluded:
                self.fixes.XFixesDestroyRegion(self.display, excluded)
            self.fixes.XFixesDestroyRegion(self.display, region)

    def detach(self, token):
        self.placement_errors.pop(token, None)
        item = self.attached.get(token)
        if not item:
            return
        if self.valid(item):
            window = item["window"]
            self.x.XUnmapWindow(self.display, window)
            self.x.XReparentWindow(self.display, window, self.root, item["x"], item["y"])
            self.x.XMoveResizeWindow(self.display, window, item["x"], item["y"], item["width"], item["height"])
            self.x.XSetWindowBorderWidth(self.display, window, item["border"])
            for name, saved in item["properties"].items():
                self.restore_property(window, name, saved)
            self.x.XMapWindow(self.display, window)
            self.sync()
            if item["saved"]:
                self.fixes.XFixesChangeSaveSet(self.display, window, 1, 1, 0)
                self.sync()
        # Never destroy a container if restoring its still-live client failed.
        if item["container"]:
            if self.children(item["container"])[1]:
                raise RuntimeError("The window identity changed. Restoring through the X11 save-set instead of destroying its container.")
            self.x.XDestroyWindow(self.display, item["container"])
            self.sync()
        del self.attached[token]

    def pointer(self, window):
        root, child, rx, ry, x, y, mask = U(), U(), I(), I(), I(), I(), C.c_uint()
        self.x.XQueryPointer(self.display, window, C.byref(root), C.byref(child), C.byref(rx), C.byref(ry), C.byref(x), C.byref(y), C.byref(mask))
        self.sync()
        return child.value, x.value, y.value, mask.value

    def tick(self):
        if os.getppid() != self.owner_pid or process_identity(self.owner_pid) != self.owner_identity:
            raise SystemExit()
        host = self.attributes(self.parent)
        for token, item in list(self.attached.items()):
            if not self.valid(item):
                self.detach(token)
            else:
                try:
                    self.render(item, host)
                except RuntimeError as error:
                    self.detach(token)
                    self.placement_errors[token] = str(error)
        if not self.attached:
            return
        root_child, _, _, mask = self.pointer(self.root)
        down = bool(mask & (1 << 8))
        pressed, self.button_down = down and not self.button_down, down
        if not pressed or root_child != self.top_level():
            return
        # Only a real click in the host's foreground X11 branch may move focus.
        for token, item in self.attached.items():
            if not item["visible"]:
                continue
            child, x, y, _ = self.pointer(item["container"])
            bounds = self.attributes(item["container"])
            if any(hx <= x < hx + hw and hy <= y < hy + hh for hx, hy, hw, hh in item.get("shape", (0, 0, ()))[2]):
                continue
            if child == item["window"] and 0 <= x < bounds.width and 0 <= y < bounds.height:
                self.x.XSetInputFocus(self.display, item["window"], 2, 0)
                self.sync()
                print(json.dumps({"event": "focus", "token": token}), flush=True)
                break

    def close(self):
        for token in list(self.attached):
            try:
                self.detach(token)
            except Exception as error:
                print(str(error), file=sys.stderr)
        # XFixes saves any client whose explicit restoration failed.
        self.x.XCloseDisplay(self.display)


def stop(_signal, _frame):
    raise SystemExit()


def main():
    host = Host(int(sys.argv[1]), int(sys.argv[2]))
    selector = selectors.DefaultSelector()
    selector.register(sys.stdin.fileno(), selectors.EVENT_READ)
    buffer = b""
    try:
        while True:
            # shortcut: pointer polling can miss very short clicks; replace with
            # XInput2 observation if this is seen during interactive acceptance.
            if selector.select(0.01 if host.attached else 0.25):
                chunk = os.read(sys.stdin.fileno(), 65536)
                if not chunk:
                    return
                buffer += chunk
                if len(buffer) > 65536:
                    raise ValueError("Desktop helper request exceeds 64 KiB.")
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    request = None
                    try:
                        request = json.loads(line)
                        if not isinstance(request, dict) or not isinstance(request.get("id"), str) or len(request["id"]) > 80:
                            raise ValueError("Invalid desktop helper request.")
                        action = request.get("action")
                        if action != "list" and (not isinstance(request.get("token"), str) or len(request["token"]) > 400):
                            raise ValueError("Invalid desktop card identity.")
                        result = None
                        if action == "list":
                            result = host.candidates()
                        elif action == "attach":
                            host.attach(request)
                        elif action == "update":
                            host.update(request)
                        elif action == "detach":
                            host.detach(request["token"])
                        else:
                            raise ValueError("Unsupported desktop window action.")
                        response = {"id": request["id"], "ok": True, "result": result}
                    except Exception as error:
                        response = {"id": request.get("id") if isinstance(request, dict) else None, "ok": False, "error": str(error)}
                    print(json.dumps(response, ensure_ascii=True), flush=True)
            host.tick()
    finally:
        selector.close()
        host.close()


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        main()
    except (OSError, ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
