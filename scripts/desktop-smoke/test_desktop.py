"""Regression checks for desktop process ownership without touching the desktop."""
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

from desktop import stop


class CleanupTests(unittest.TestCase):
    @unittest.skipIf(sys.platform == 'win32', 'POSIX detached process groups')
    def test_launcher_can_clean_up_its_detached_app(self):
        with tempfile.TemporaryDirectory() as directory:
            ready = Path(directory) / 'ready'
            cleaned = Path(directory) / 'cleaned'
            script = '''
import os, signal, subprocess, sys, time
from pathlib import Path
child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'], start_new_session=True)
def cleanup(*_):
    os.killpg(child.pid, signal.SIGTERM)
    child.wait(timeout=5)
    Path(sys.argv[2]).write_text('cleaned')
    sys.exit(0)
signal.signal(signal.SIGTERM, cleanup)
Path(sys.argv[1]).write_text(str(child.pid))
while True: time.sleep(0.1)
'''
            parent = subprocess.Popen([sys.executable, '-c', script, str(ready), str(cleaned)], start_new_session=True)
            try:
                deadline = time.monotonic() + 10
                while not ready.exists() and time.monotonic() < deadline:
                    time.sleep(0.05)
                self.assertTrue(ready.exists(), 'fixture did not start')
                stop(parent)
                self.assertEqual(parent.returncode, 0)
                self.assertEqual(cleaned.read_text(), 'cleaned')
            finally:
                if parent.poll() is None:
                    os.killpg(parent.pid, signal.SIGKILL)
                    parent.wait()
                if ready.exists():
                    try:
                        os.killpg(int(ready.read_text()), signal.SIGKILL)
                    except ProcessLookupError:
                        pass


if __name__ == '__main__':
    unittest.main()
