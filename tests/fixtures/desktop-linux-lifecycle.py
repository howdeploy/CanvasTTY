import importlib.util
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location(
    "window_host", Path(__file__).resolve().parents[2] / "native/desktop-apps-linux/window-host.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Lifecycle(unittest.TestCase):
    def setUp(self):
        self.host = host = module.Host.__new__(module.Host)
        host.owner_pid, host.owner_identity = os.getppid(), "owner"
        host.display, host.root, host.parent = None, 1, 2
        self.client, self.container = 3, 4
        self.mapped, self.container_mapped, self.alive = True, True, True
        self.parent = self.container
        self.item = {"window": self.client, "container": self.container,
                     "x": 10, "y": 20, "width": 800, "height": 600,
                     "border": 1, "properties": {}, "saved": True, "visible": True}
        host.attached, host.placement_errors = {"card": self.item}, {}
        host.valid = lambda _item: self.alive
        host.attributes = self.attributes
        host.children = lambda _window: (host.parent, [self.client] if self.alive and self.parent == self.container else [])
        host.sync, host.restore_property = Mock(), Mock()
        host.render = Mock()
        host.pointer = lambda _window: (0, 0, 0, 0)
        host.button_down = False
        host.x, host.fixes = Mock(), Mock()
        host.x.XMapWindow.side_effect = self.map_window
        host.x.XUnmapWindow.side_effect = self.unmap_window
        host.x.XReparentWindow.side_effect = self.reparent

    def attributes(self, window):
        if window == self.client:
            if not self.alive:
                raise RuntimeError("BadWindow")
            return SimpleNamespace(map_state=0 if not self.mapped else 2 if self.container_mapped else 1)
        return SimpleNamespace(map_state=2, width=1000, height=800)

    def map_window(self, _display, window):
        if window == self.client:
            self.mapped = True

    def unmap_window(self, _display, window):
        if window == self.client:
            self.mapped = False

    def reparent(self, _display, _window, parent, _x, _y):
        # XReparentWindow preserves the client's mapped state on the server.
        self.parent = parent

    def tick(self):
        with patch.object(module, "process_identity", return_value="owner"):
            self.host.tick()

    def assert_removed(self):
        self.assertFalse(self.host.attached)
        self.host.x.XDestroyWindow.assert_called_once_with(None, self.container)

    def test_client_close_to_tray_removes_container_without_showing_client(self):
        self.mapped = False
        self.tick()
        self.assert_removed()
        self.assertFalse(self.mapped)
        self.host.render.assert_not_called()
        self.host.fixes.XFixesChangeSaveSet.assert_called_once_with(None, self.client, 1, 1, 0)

    def test_detach_after_close_does_not_resurrect_client(self):
        self.mapped = False
        self.host.detach("card")
        self.assert_removed()
        self.assertFalse(self.mapped)
        self.assertEqual(self.parent, self.host.root)

    def test_host_exit_does_not_resurrect_client(self):
        self.mapped = False
        self.host.close()
        self.assert_removed()
        self.assertFalse(self.mapped)
        self.host.x.XCloseDisplay.assert_called_once()

    def test_destroyed_client_removes_empty_container(self):
        self.alive = False
        self.tick()
        self.assert_removed()
        self.host.x.XReparentWindow.assert_not_called()

    def test_hidden_ancestor_does_not_count_as_client_close(self):
        self.container_mapped = False
        self.tick()
        self.assertIn("card", self.host.attached)
        self.host.render.assert_called_once()
        self.host.x.XDestroyWindow.assert_not_called()

    def test_detach_from_hidden_card_preserves_mapped_client(self):
        self.container_mapped = False
        self.host.detach("card")
        self.assert_removed()
        self.assertTrue(self.mapped)
        self.assertEqual(self.parent, self.host.root)

    def test_render_only_shows_container_when_card_becomes_visible(self):
        self.item.update(visible=False, placement=(0, 0, 100, 100), layout=(0, 0, 100, 100),
                         shape=(100, 100, ()), viewport=(0, 0, 100, 100, 1000, 800, 0, 0, 1000, 800, True))
        self.host.attributes = lambda _window: SimpleNamespace(x=0, y=0, width=100, height=100)
        module.Host.render(self.host, self.item, SimpleNamespace(width=1000, height=800, map_state=2))
        self.host.x.XMapWindow.assert_called_once_with(None, self.container)


if __name__ == "__main__":
    unittest.main()
