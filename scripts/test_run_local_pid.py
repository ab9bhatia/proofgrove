import tempfile
import unittest
from pathlib import Path
from run_local import release_pid_file

class PidTests(unittest.TestCase):
    def test_only_own_record_is_released(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "launcher.pid"
            path.write_text("123")
            release_pid_file(path, 456)
            self.assertEqual(path.read_text(), "123")
            release_pid_file(path, 123)
            self.assertFalse(path.exists())
            release_pid_file(path, 123)
