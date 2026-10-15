"""PTY integration tests: exercise prompts and fail closed on early exit."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


@unittest.skipIf(sys.platform == 'win32', 'POSIX fake executable; real ConPTY is exercised in CI')
class PickerTests(unittest.TestCase):
    def run_picker(self, fail=False):
        with tempfile.TemporaryDirectory() as work:
            root = Path(work)
            fake = root / 'hutch'
            fake.write_text('#!' + sys.executable + '\n' + '''import os, sys, termios, tty
assert sys.argv[1:] == ['electrobun', 'init', '--beta']
assert sys.stdin.isatty() and sys.stdout.isatty()
old = termios.tcgetattr(0)
tty.setraw(0)
print('Choose an Electrobun beta template', flush=True)
keys = b''
while not keys.endswith(b'\\r'):
    keys += os.read(0, 1)
assert keys == b'\\x1b[B\\x1b[B\\r', repr(keys)
termios.tcsetattr(0, termios.TCSANOW, old)
print('Selected Bunny', flush=True)
print('Project name [bunny]: ', end='', flush=True)
name = sys.stdin.readline().strip()
assert name == 'smoke-bunny', repr(name)
print('Downloading bunny from Electrobun 2.0.3-beta.25 (beta)...', flush=True)
''' + ("sys.exit(1)\n" if fail else "print('Created Electrobun project at /tmp/smoke-bunny', flush=True)\n"))
            fake.chmod(0o755)
            plan = dict(hutch=str(fake), channel='beta', cwd=work, index=2, id='bunny', label='Bunny', projectName='smoke-bunny', version='2.0.3-beta.25', log=str(root / 'picker.log'))
            path = root / 'plan.json'
            path.write_text(json.dumps(plan))
            return subprocess.run([sys.executable, str(Path(__file__).with_name('picker.py')), str(path)], capture_output=True, text=True, timeout=15)

    def test_picker_uses_beta_arrows_and_name_prompt(self):
        result = self.run_picker()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_init_failure_is_not_accepted(self):
        result = self.run_picker(fail=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('did not finish successfully', result.stderr)


if __name__ == '__main__':
    unittest.main()
