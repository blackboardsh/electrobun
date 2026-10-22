"""Regression checks for desktop process ownership without touching the desktop."""
import os
import ctypes
import json
from collections import namedtuple
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch
from types import SimpleNamespace

import desktop
from desktop import stop, counter_difference, ocr_regions, ocr_token, rendered_surface, app_failure


class WindowsDiagnosticTests(unittest.TestCase):
    def fake_user(self):
        # High bits catch accidental 32-bit HWND conversions even when these
        # tests run on macOS/Linux without loading user32.
        target, child, other = 0x1234567887654321, 0x1234567887654322, 0x1234567887654323
        def rect(hwnd, pointer):
            value = pointer._obj
            value.left, value.top, value.right, value.bottom = 10, 20, 210, 120
            return 1
        def owner(hwnd, pointer):
            pointer._obj.value = 77 if hwnd in (target, child) else 88
            return 99
        def layered(hwnd, color, alpha, flags):
            color._obj.value, alpha._obj.value, flags._obj.value = 0, 255, 2
            return 1
        user = SimpleNamespace(**{name: Mock(side_effect=effect) for name, effect in {
            'SetProcessDPIAware': lambda: 1,
            'FindWindowW': lambda cls, title: target,
            'IsWindow': lambda hwnd: bool(hwnd),
            'IsWindowVisible': lambda hwnd: bool(hwnd),
            'GetWindowRect': rect,
            'GetWindowThreadProcessId': owner,
            'GetForegroundWindow': lambda: target,
            'GetWindow': lambda hwnd, direction: other if hwnd == target else target,
            'WindowFromPoint': lambda point: child,
            'GetAncestor': lambda hwnd, flag: target,
            'GetWindowLongPtrW': lambda hwnd, index: 8 if index == -20 else -2147483648,
            'GetLayeredWindowAttributes': layered,
            'GetWindowDisplayAffinity': lambda hwnd, pointer: 0,
            'ShowWindow': lambda hwnd, command: 0,
            'SetWindowPos': lambda *args: 1,
            'SetForegroundWindow': lambda hwnd: 1,
        }.items()})
        return user, target, child, other

    def test_windows_observation_preserves_hwnd_width_and_child_hit_and_bounds_z_order(self):
        from ctypes import wintypes
        user, target, child, other = self.fake_user()
        with patch.object(ctypes, 'windll', SimpleNamespace(user32=user), create=True):
            state = desktop.windows_window_state(target)
        self.assertEqual(state['hwnd'], target)
        self.assertEqual(state['pid'], 77)
        self.assertEqual(state['style'], 0x80000000)
        self.assertTrue(state['topmost'])
        self.assertEqual(state['windowFromPointHwnd'], child)
        self.assertEqual(state['windowFromPointRootHwnd'], target)
        self.assertEqual(state['windowFromPoint']['pid'], 77)
        self.assertEqual(state['occlusionCandidates'][0]['hwnd'], other)
        self.assertEqual(state['zOrderWindowsExamined'], 1)
        self.assertFalse(state['zOrderTruncated'])
        self.assertEqual(state['layeredWindowAttributes']['alpha'], 255)
        self.assertEqual(state['displayAffinity'], {'return': 0, 'value': None})
        for name in ('GetForegroundWindow', 'GetWindow', 'WindowFromPoint', 'GetAncestor'):
            self.assertIs(getattr(user, name).restype, wintypes.HWND)
        self.assertEqual(user.WindowFromPoint.argtypes, [wintypes.POINT])
        self.assertIs(user.GetWindowLongPtrW.restype, ctypes.c_ssize_t)

    def test_activation_records_original_calls_once_and_never_adds_input(self):
        user, target, _, _ = self.fake_user()
        ordering = Mock()
        for name in ('ShowWindow', 'GetWindowRect', 'SetWindowPos', 'SetForegroundWindow'):
            ordering.attach_mock(getattr(user, name), name)
        diagnostics = Mock()
        with patch.object(desktop.sys, 'platform', 'win32'), patch.object(ctypes, 'windll', SimpleNamespace(user32=user), create=True):
            self.assertEqual(desktop.window('Bunny', diagnostics=diagnostics), (10, 20, 200, 100))
        self.assertEqual([call[0] for call in ordering.mock_calls],
                         ['ShowWindow', 'GetWindowRect', 'SetWindowPos', 'SetForegroundWindow'])
        label, handle, returns = diagnostics.record.call_args.args
        self.assertEqual((label, handle), ('activation', target))
        self.assertEqual(returns, {'SetProcessDPIAware': 1, 'ShowWindowPreviousVisibility': 0,
                                   'GetWindowRect': 1, 'SetWindowPos': 1, 'SetForegroundWindow': 1})

    def exercise_failure(self, enabled, platform='win32', broken_diagnostics=False):
        from PIL import Image
        frame = Image.new('RGB', (160, 100), 'black')
        frame.paste('white', (0, 0, 80, 100))
        size = namedtuple('Size', 'width height')(160, 100)
        gui = SimpleNamespace(position=Mock(return_value=(4, 5)), size=Mock(return_value=size),
                              moveTo=Mock(), screenshot=Mock(return_value=frame))
        process = Mock()
        process.poll.return_value = None
        state = {'hwnd': 123, 'pid': 77, 'isWindow': True, 'visible': True, 'bounds': [0, 0, 160, 100]}
        active_finished = []
        def lookup(title, activate=True, diagnostics=None):
            if diagnostics is not None:
                diagnostics.record('activation' if activate else 'observation', 123)
            return 0, 0, 160, 100
        def observe(handle):
            if broken_diagnostics and active_finished:
                raise OSError('diagnostic read failed')
            return state.copy()
        def sleep(seconds):
            # Every added one-second wait must occur after the original
            # expectChange failure and its unchanged failure.png capture.
            if seconds == 1:
                self.assertTrue(active_finished)
        def screenshot():
            if gui.screenshot.call_count == 3:
                active_finished.append(True)
            if broken_diagnostics and gui.screenshot.call_count > 3:
                raise OSError('diagnostic screenshot failed')
            return frame if gui.screenshot.call_count <= 3 else Image.new('RGB', frame.size, 'red')
        gui.screenshot.side_effect = screenshot
        with tempfile.TemporaryDirectory() as directory:
            plan = {'name': 'bunny', 'title': 'Bunny', 'output': directory, 'cwd': directory,
                    'command': ['unused'], 'diagnostics': enabled,
                    'actions': [{'move': [0.5, 0.5], 'expectChange': True, 'settle': 0}]}
            with patch.dict(sys.modules, {'pyautogui': gui, 'pytesseract': SimpleNamespace()}), \
                    patch.object(desktop.sys, 'platform', platform), patch.object(desktop, 'window', side_effect=lookup), \
                    patch.object(desktop, 'windows_window_state', side_effect=observe) as observations, \
                    patch.object(desktop.subprocess, 'Popen', return_value=process), patch.object(desktop, 'stop'), \
                    patch.object(desktop.time, 'sleep', side_effect=sleep) as sleeps:
                with self.assertRaisesRegex(AssertionError, '^Input did not produce a visible change$'):
                    desktop.inspect_app(plan)
            result = json.loads((Path(directory) / 'result.json').read_text())
            self.assertFalse(result['ok'])
            self.assertEqual(result['error'], 'Input did not produce a visible change')
            self.assertNotIn('visible-response-to-input', result['checks'])
            self.assertEqual(gui.moveTo.call_count, 2)
            self.assertIn('failure.png', result['screenshots'])
            return result, [call.args[0] for call in sleeps.call_args_list], observations.call_count

    def test_diagnostics_are_opt_in_and_add_no_delay_to_original_assertion(self):
        result, sleeps, observations = self.exercise_failure(False)
        self.assertEqual(sleeps, [2, 2, 0])
        self.assertEqual(observations, 0)
        self.assertNotIn('windowReadings', result)
        result, sleeps, observations = self.exercise_failure(True, platform='darwin')
        self.assertEqual(sleeps, [2, 2, 0])
        self.assertEqual(observations, 0)
        result, sleeps, observations = self.exercise_failure(True)
        self.assertEqual(sleeps, [2, 2, 0, 1, 1, 1])
        self.assertGreater(observations, 3)
        self.assertEqual([item['hwnd'] for item in result['windowReadings'] if item['label'].startswith('failure-later')], [123] * 3)
        self.assertTrue(result['pointerReadings'])

    def test_diagnostic_read_and_capture_errors_preserve_original_failure(self):
        result, sleeps, _ = self.exercise_failure(True, broken_diagnostics=True)
        self.assertEqual(sleeps, [2, 2, 0, 1, 1, 1])
        self.assertEqual(len(result['diagnosticErrors']), 6)

    def test_post_failure_never_follows_reused_hwnd_to_another_pid(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as directory:
            result = {'ok': False, 'error': 'original'}
            diagnostic = desktop.WindowsWindowDiagnostics(Path(directory), result)
            state = {'hwnd': 123, 'pid': 77, 'isWindow': True, 'visible': True, 'bounds': [0, 0, 2, 2]}
            with patch.object(desktop, 'windows_window_state', return_value=state):
                diagnostic.record('activation', 123)
            state = {**state, 'pid': 88}
            gui = Mock()
            gui.screenshot.return_value = Image.new('RGB', (2, 2))
            with patch.object(desktop, 'windows_window_state', return_value=state) as observations, patch.object(desktop.time, 'sleep'):
                diagnostic.after_failure(gui, [])
            self.assertEqual([call.args for call in observations.call_args_list], [(123,)] * 3)
            self.assertTrue(all(not row['sameOriginalWindow'] for row in result['windowReadings'][1:]))
            gui.size.assert_not_called()
            self.assertEqual(result['error'], 'original')
            self.assertFalse(result['ok'])


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


class AppExitTests(unittest.TestCase):
    def test_rust_stack_overflow_is_not_hidden_by_watch_mode(self):
        # Actual Windows x64 source run 38714107840. The watcher remained
        # alive for ten minutes after its child exited before creating a window.
        log = """[electrobun dev --watch] Watching for changes...
Child process spawned with PID 6396
thread 'main' has overflowed its stack
Child process exited with code: 3221225725
"""
        self.assertIn('stack overflow', app_failure(log))
        self.assertIsNone(app_failure('Child process spawned with PID 6396'))

    def test_clean_early_exit_is_not_a_running_app(self):
        self.assertIsNotNone(app_failure('Child process exited with code: 0'))


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

    def test_native_font_reset_tolerates_subpixel_edges(self):
        from PIL import Image
        fixtures = Path(__file__).parent / 'fixtures'
        # Real macOS source run 38714107840: the visible event log confirms
        # increment to 1 and reset to 0; layout shifts change antialiased edges.
        initial = Image.open(fixtures / 'macos-counter-zero.png')
        incremented = Image.open(fixtures / 'macos-counter-one.png')
        reset = Image.open(fixtures / 'macos-counter-reset.png')
        self.assertGreater(counter_difference(initial, incremented), 2)
        self.assertLess(counter_difference(initial, reset), 0.5)
        self.assertGreater(counter_difference(incremented, reset), 2)

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
    def test_windows_rust_cursor_label_and_coordinates(self):
        # Real Windows x64 run 38719590710: OCR read the label as ‘CURSOR.
        from PIL import Image
        import pytesseract
        if os.environ.get('SMOKE_TESSERACT'):
            pytesseract.pytesseract.tesseract_cmd = os.environ['SMOKE_TESSERACT']
        self.assertEqual(ocr_token('‘CURSOR'), 'cursor')
        frame = Image.open(Path(__file__).parent / 'fixtures' / 'windows-rust-cursor.png')
        data = pytesseract.image_to_data(frame, config='--psm 11', output_type=pytesseract.Output.DICT)
        labels = [i for i, word in enumerate(data['text']) if ocr_token(word) == 'cursor']
        self.assertTrue(labels, data['text'])
        i = labels[0]
        x = data['left'][i] + data['width'][i] / 2
        y = data['top'][i] + data['height'][i] / 2
        readout = frame.crop((round(x - 45), round(y + 5), round(x + 150), round(y + 45)))
        value = pytesseract.image_to_string(readout, config='--psm 6 -c tessedit_char_whitelist=0123456789,')
        self.assertEqual(value.strip().replace(' ', ''), '312,290')

    def test_colored_buttons_from_real_ci_screenshots(self):
        # macOS Zig and Linux Odin from published smoke run 38692395840.
        from PIL import Image
        import pytesseract
        if os.environ.get('SMOKE_TESSERACT'):
            pytesseract.pytesseract.tesseract_cmd = os.environ['SMOKE_TESSERACT']
        for fixture, label in [('zig-toggle.png', 'Toggle'), ('odin-resume.png', 'Resume'), ('windows-odin-pause.png', 'Pause')]:
            with self.subTest(label=label):
                frame = Image.open(Path(__file__).parent / 'fixtures' / fixture)
                # Maximized Windows bounds include an offscreen border.
                if label == 'Pause':
                    frame = frame.crop((-8, -8, frame.width+8, frame.height+8))
                texts = [pytesseract.image_to_string(region, config=config)
                         for region, _, config, _, _ in ocr_regions(frame)]
                self.assertIn(label, '\n'.join(texts))
                if label == 'Pause':
                    points = []
                    for region, top, config, scale, left in ocr_regions(frame):
                        data = pytesseract.image_to_data(region, config=config,
                                                        output_type=pytesseract.Output.DICT)
                        for i, word in enumerate(data['text']):
                            if word == 'Pause':
                                points.append((left + (data['left'][i] + data['width'][i]/2)/scale,
                                               top + (data['top'][i] + data['height'][i]/2)/scale))
                    self.assertTrue(any(554 < x < 631 and 62 < y < 105 for x, y in points), points)


if __name__ == '__main__':
    unittest.main()
