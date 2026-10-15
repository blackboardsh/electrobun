"""Regression checks for desktop process ownership without touching the desktop."""
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

from desktop import stop, counter_difference, ocr_regions, rendered_surface


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


class CounterImageTests(unittest.TestCase):
    # Crops from the actual Windows smoke run 38688347101: zero at startup,
    # then one after a keyboard increment. No DOM or generated reference image.
    def setUp(self):
        from PIL import Image
        fixtures = Path(__file__).parent / 'fixtures'
        self.zero = Image.open(fixtures / 'counter-zero.png').convert('RGB')
        self.one = Image.open(fixtures / 'counter-one.png').convert('RGB')

    def test_real_counter_increment_changes_pixels(self):
        self.assertGreater(counter_difference(self.zero, self.one), 2)

    def test_unchanged_counter_cannot_pass_increment(self):
        self.assertEqual(counter_difference(self.zero, self.zero.copy()), 0)

    def test_real_template_reset_survives_layout_shift(self):
        from PIL import Image
        fixtures = Path(__file__).parent / 'fixtures'
        # Actual Linux captures from run 38694841883 before and after reset.
        initial = Image.open(fixtures / 'template-counter-zero.png')
        reset = Image.open(fixtures / 'template-counter-reset.png')
        self.assertEqual(counter_difference(initial, reset), 0)

    def test_blank_counter_is_not_a_valid_change(self):
        from PIL import Image
        with self.assertRaisesRegex(AssertionError, 'missing'):
            counter_difference(self.zero, Image.new('RGB', self.zero.size, '#13131c'))


class SurfaceImageTests(unittest.TestCase):
    def test_visible_controls_do_not_hide_a_blank_gpu_surface(self):
        from PIL import Image, ImageDraw
        frame = Image.new('RGB', (1000, 700), 'white')
        ImageDraw.Draw(frame).text((10, 10), 'Surface ready - Toggle', fill='black')
        self.assertFalse(rendered_surface(frame, [0.08, 0.25, 0.60, 0.85]))


class ButtonOCRTests(unittest.TestCase):
    def test_colored_buttons_from_real_ci_screenshots(self):
        # macOS Zig and Linux Odin from published smoke run 38692395840.
        from PIL import Image
        import pytesseract
        if os.environ.get('SMOKE_TESSERACT'):
            pytesseract.pytesseract.tesseract_cmd = os.environ['SMOKE_TESSERACT']
        for fixture, label in [('zig-toggle.png', 'Toggle'), ('odin-resume.png', 'Resume')]:
            with self.subTest(label=label):
                frame = Image.open(Path(__file__).parent / 'fixtures' / fixture)
                texts = [pytesseract.image_to_string(region, config=config)
                         for region, _, config in ocr_regions(frame)]
                self.assertIn(label, '\n'.join(texts))


if __name__ == '__main__':
    unittest.main()
