import unittest
from unittest.mock import Mock

from desktop_status import DesktopStatus


class DesktopStatusTest(unittest.TestCase):
    def setUp(self):
        self.desktop = DesktopStatus()
        self.desktop.initialize_id = "init"
        self.desktop.following.add("chat")
        self.desktop.follow = Mock()

    def publish(self, source="owner", **change):
        self.desktop.handle({
            "method": "thread-stream-state-changed", "version": 11,
            "sourceClientId": source,
            "params": {"hostId": "local", "conversationId": "chat", "change": change},
        })

    def snapshot(self, status):
        self.publish(type="snapshot", revision=1, conversationState={"threadRuntimeStatus": status})

    def test_runtime_updates_change_the_label(self):
        self.snapshot({"type": "active", "activeFlags": []})
        self.assertEqual(self.desktop.status("chat"), "working")
        for revision, (status, expected) in enumerate([
            ({"type": "active", "activeFlags": ["waitingOnApproval"]}, "approval"),
            ({"type": "active", "activeFlags": ["waitingOnUserInput"]}, "input"),
            ({"type": "idle"}, "idle"),
            ({"type": "notLoaded"}, None),
        ], start=2):
            self.publish(type="patches", revision=revision, baseRevision=revision - 1, patches=[
                {"op": "replace", "path": ["threadRuntimeStatus"], "value": status},
            ])
            self.assertEqual(self.desktop.status("chat"), expected)

    def test_missed_revision_clears_the_status_before_resubscribing(self):
        self.snapshot({"type": "active"})
        self.publish(type="patches", revision=3, baseRevision=2, patches=[])
        self.assertIsNone(self.desktop.status("chat"))
        self.desktop.follow.assert_called_once_with("chat", True)

    def test_owner_disconnect_clears_the_status(self):
        self.snapshot({"type": "active"})
        self.desktop.handle({
            "method": "client-status-changed",
            "params": {"clientId": "owner", "status": "disconnected"},
        })
        self.assertIsNone(self.desktop.status("chat"))
        self.desktop.follow.assert_called_once_with("chat", True)

    def test_unrelated_patches_do_not_change_the_status(self):
        self.snapshot({"type": "active"})
        self.publish(type="patches", revision=2, baseRevision=1, patches=[
            {"op": "replace", "path": ["turnHistory", "history"], "value": {}},
        ])
        self.assertEqual(self.desktop.status("chat"), "working")
        self.desktop.follow.assert_not_called()


if __name__ == "__main__":
    unittest.main()
