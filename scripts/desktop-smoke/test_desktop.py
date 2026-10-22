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
        ocr = SimpleNamespace(pytesseract=SimpleNamespace(tesseract_cmd='unused'))
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
            with patch.dict(sys.modules, {'pyautogui': gui, 'pytesseract': ocr}), \
                    patch.dict(desktop.os.environ, {'SMOKE_TESSERACT': 'mock-tesseract'}), \
                    patch.object(desktop.sys, 'platform', platform), patch.object(desktop, 'window', side_effect=lookup), \
                    patch.object(desktop, 'windows_window_state', side_effect=observe) as observations, \
                    patch.object(desktop.subprocess, 'Popen', return_value=process), patch.object(desktop, 'stop'), \
                    patch.object(desktop.time, 'sleep', side_effect=sleep) as sleeps:
                with self.assertRaisesRegex(AssertionError, '^Input did not produce a visible change$'):
                    desktop.inspect_app(plan)
                self.assertEqual(ocr.pytesseract.tesseract_cmd, 'mock-tesseract')
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


class NativeOnlyDiagnosticTests(unittest.TestCase):
    def exercise_outcome(self, *, success=False, enabled=True, legacy=True,
                         platform='win32', ownership=True, reused=False, initial_reused=False,
                         broken=False, thread_errors=False):
        from contextlib import ExitStack
        from PIL import Image, ImageChops
        frame = Image.new('RGB', (160, 100), 'black')
        frame.paste('white', (0, 0, 80, 100))
        changed = ImageChops.invert(frame)
        size = namedtuple('Size', 'width height')(160, 100)
        gui = SimpleNamespace(position=Mock(return_value=(80, 50)), size=Mock(return_value=size),
                              moveTo=Mock(), screenshot=Mock())
        ocr = SimpleNamespace(pytesseract=SimpleNamespace(tesseract_cmd='unused'))
        process = Mock(pid=9)
        process.poll.return_value = None
        user, handle, _, _ = WindowsDiagnosticTests().fake_user()
        events = []
        fixed = []
        active_shots = 2 if success else 3
        original_error = 'Input did not produce a visible change'
        original_helper = desktop.native_only_after_outcome
        original_constructor = desktop.WindowsWindowDiagnostics
        original_find = desktop.windows_find_window

        def assert_fixed(operation):
            self.assertTrue(fixed, f'{operation} ran before the original outcome was fixed')
            outcome = fixed[0]
            self.assertEqual(outcome['ok'], success)
            self.assertEqual(outcome.get('error'), None if success else original_error)
            events.append(('native', operation))

        def construct(output, result):
            assert_fixed('constructor')
            self.assertIs(result, fixed[0])
            return original_constructor(output, result)

        def find(title):
            assert_fixed('FindWindowW')
            return original_find(title)

        def ancestry(window_pid, root_pid):
            assert_fixed('process ancestry')
            self.assertEqual((window_pid, root_pid), (77, process.pid))
            return {'verified': ownership, 'windowPid': window_pid, 'rootPid': root_pid,
                    'chain': [77, 55, 9] if ownership else [77, 55]}

        def observe(hwnd):
            assert_fixed('window state')
            self.assertEqual(hwnd, handle)
            if broken and observations.call_count > 1:
                raise OSError('post-outcome native read failed')
            return {'hwnd': hwnd, 'pid': 88 if initial_reused or reused and observations.call_count > 1 else 77,
                    'threadId': 99, 'isWindow': True, 'visible': True, 'bounds': [0, 0, 160, 100]}

        def thread_read(kind, *args):
            assert_fixed(kind)
            self.assertTrue(ownership)
            self.assertFalse(initial_reused)
            self.assertEqual(ancestries.call_count, 1)
            self.assertEqual(observations.call_count, 1, 'thread reads require the verified initial window state')
            self.assertEqual(args, (77, 99, handle) if kind == 'child threads' else (77, 99))
            if thread_errors:
                if kind == 'process threads':
                    raise subprocess.TimeoutExpired('powershell', 3)
                raise OSError(kind + ' read failed')
            return {'windowThreadId': 99, 'inspectedPid': 77}

        def pointer():
            assert_fixed('pointer position')
            return 80, 50

        def lookup(title, activate=True, diagnostics=None):
            self.assertFalse(fixed, 'post-outcome diagnostics must not re-find or reactivate through window()')
            self.assertIsNone(diagnostics, 'legacy native diagnostics must be suppressed during active assertions')
            events.append(('window', activate))
            return 0, 0, 160, 100

        def move(*args, **kwargs):
            self.assertFalse(fixed, 'diagnostics must not add mouse input after the outcome')
            events.append(('move', args, kwargs))

        def sleep(seconds):
            events.append(('sleep', seconds, bool(fixed)))
            if fixed:
                self.assertFalse(success, 'successful checks must not gain diagnostic waits')
                self.assertEqual(seconds, 1)

        def screenshot():
            count = gui.screenshot.call_count
            events.append(('screenshot', count, bool(fixed)))
            if count <= active_shots:
                self.assertFalse(fixed, 'all original screenshots must precede diagnostics')
                return changed if success and count == 2 else frame
            assert_fixed('later screenshot')
            if broken:
                raise OSError('post-outcome screenshot failed')
            # Later painting is intentionally dramatic. It cannot rescue the
            # original expectChange assertion or overwrite its failure.png.
            return Image.new('RGB', frame.size, 'red')

        def after_outcome(plan, output, result, child, actual_gui, shots):
            self.assertEqual(result['ok'], success)
            self.assertEqual(result.get('error'), None if success else original_error)
            self.assertEqual(gui.screenshot.call_count, active_shots)
            self.assertEqual(shots, ['01-rendered.png', '02-02-interaction.png'] + ([] if success else ['failure.png']))
            if not success:
                with Image.open(Path(output) / 'failure.png') as failure:
                    self.assertIsNone(ImageChops.difference(failure.convert('RGB'), frame).getbbox())
            self.assertIs(child, process)
            self.assertIs(actual_gui, gui)
            fixed.append(result)
            original_outcome = (result['ok'], result.get('error'), list(result['checks']))
            original_helper(plan, output, result, child, actual_gui, shots)
            self.assertEqual((result['ok'], result.get('error'), result['checks']), original_outcome)

        gui.position.side_effect = pointer
        gui.moveTo.side_effect = move
        gui.screenshot.side_effect = screenshot
        with tempfile.TemporaryDirectory() as directory:
            plan = {'name': 'bunny', 'title': 'Bunny', 'output': directory, 'cwd': directory,
                    'command': ['unused'], 'nativeOnlyDiagnostics': enabled, 'diagnostics': legacy,
                    'actions': [{'move': [0.5, 0.5], 'expectChange': True, 'settle': 0}]}
            with ExitStack() as patches:
                patches.enter_context(patch.dict(sys.modules, {'pyautogui': gui, 'pytesseract': ocr}))
                patches.enter_context(patch.object(desktop.sys, 'platform', platform))
                patches.enter_context(patch.object(ctypes, 'windll', SimpleNamespace(user32=user), create=True))
                patches.enter_context(patch.object(desktop.subprocess, 'Popen', return_value=process))
                patches.enter_context(patch.object(desktop, 'stop'))
                patches.enter_context(patch.object(desktop, 'window', side_effect=lookup))
                patches.enter_context(patch.object(desktop.time, 'sleep', side_effect=sleep))
                patches.enter_context(patch.object(desktop, 'native_only_after_outcome', side_effect=after_outcome))
                constructors = patches.enter_context(patch.object(desktop, 'WindowsWindowDiagnostics', side_effect=construct))
                finds = patches.enter_context(patch.object(desktop, 'windows_find_window', side_effect=find))
                ancestries = patches.enter_context(patch.object(desktop, 'windows_process_ancestry', side_effect=ancestry))
                observations = patches.enter_context(patch.object(desktop, 'windows_window_state', side_effect=observe))
                dispatcher_threads = patches.enter_context(patch.object(desktop, 'windows_dispatcher_threads',
                    side_effect=lambda *args: thread_read('dispatcher threads', *args)))
                child_threads = patches.enter_context(patch.object(desktop, 'windows_child_threads',
                    side_effect=lambda *args: thread_read('child threads', *args)))
                process_threads = patches.enter_context(patch.object(desktop, 'windows_thread_snapshot',
                    side_effect=lambda *args: thread_read('process threads', *args)))
                if success:
                    desktop.inspect_app(plan)
                else:
                    with self.assertRaisesRegex(AssertionError, '^Input did not produce a visible change$'):
                        desktop.inspect_app(plan)
            result = json.loads((Path(directory) / 'result.json').read_text())
            self.assertEqual(result['ok'], success)
            self.assertEqual(result.get('error'), None if success else original_error)
            for reader in (dispatcher_threads, child_threads, process_threads):
                self.assertEqual(reader.call_count,
                    int(enabled and platform == 'win32' and ownership and not initial_reused))
            self.assertNotIn('visibleChangeMeans', result, 'legacy metrics must also be suppressed by native-only mode')
            self.assertEqual([event for event in events if event[0] == 'window'],
                             [('window', True)] + [('window', False)] * 4)
            self.assertEqual([event for event in events if event[0] == 'move'],
                             [('move', (2, 2), {}), ('move', (80.0, 50.0), {'duration': 0.3})])
            self.assertEqual([event[1] for event in events if event[0] == 'sleep' and not event[2]], [2, 2, 0])
            user.ShowWindow.assert_not_called()
            user.SetWindowPos.assert_not_called()
            user.SetForegroundWindow.assert_not_called()
            if not success:
                with Image.open(Path(directory) / 'failure.png') as failure:
                    self.assertIsNone(ImageChops.difference(failure.convert('RGB'), frame).getbbox())
            return SimpleNamespace(result=result, events=events, gui=gui, constructors=constructors,
                                   finds=finds, ancestries=ancestries, observations=observations,
                                   thread_readers=(dispatcher_threads, child_threads, process_threads),
                                   user=user, handle=handle)

    def test_native_only_failure_observes_after_original_assertion_and_keeps_late_paint_a_failure(self):
        run = self.exercise_outcome()
        self.assertEqual(run.constructors.call_count, 1)
        self.assertEqual(run.finds.call_count, 1)
        self.assertEqual(run.user.FindWindowW.call_count, 1)
        self.assertEqual(run.ancestries.call_count, 1)
        self.assertEqual(run.observations.call_args_list, [unittest.mock.call(run.handle)] * 11)
        self.assertEqual([event[1] for event in run.events if event[0] == 'sleep' and event[2]], [1] * 10)
        self.assertEqual(run.gui.screenshot.call_count, 13)
        self.assertNotIn('visible-response-to-input', run.result['checks'])

    def test_native_only_success_is_fixed_before_summary_and_adds_no_waits_or_screenshots(self):
        run = self.exercise_outcome(success=True)
        self.assertEqual(run.constructors.call_count, 1)
        self.assertEqual(run.finds.call_count, 1)
        self.assertEqual(run.ancestries.call_count, 1)
        self.assertEqual(run.observations.call_count, 1)
        self.assertEqual(run.gui.screenshot.call_count, 2)
        self.assertFalse([event for event in run.events if event[0] == 'sleep' and event[2]])
        self.assertIn('visible-response-to-input', run.result['checks'])

    def test_native_only_diagnostic_errors_preserve_original_assertion(self):
        run = self.exercise_outcome(broken=True)
        self.assertTrue(run.result['diagnosticErrors'])
        self.assertEqual(run.finds.call_count, 1)
        self.assertEqual([event[1] for event in run.events if event[0] == 'sleep' and event[2]], [1] * 10)
        self.assertEqual(run.gui.screenshot.call_count, 13)

    def test_native_only_thread_errors_preserve_both_outcomes_and_do_not_stop_later_evidence(self):
        for success in (False, True):
            with self.subTest(success=success):
                run = self.exercise_outcome(success=success, thread_errors=True)
                self.assertEqual({error['label'] for error in run.result['diagnosticErrors']},
                                 {'native-only-dispatcherThreads', 'native-only-childThreads', 'native-only-processThreads'})
                self.assertEqual(run.gui.screenshot.call_count, 2 if success else 13)
                self.assertEqual(run.observations.call_count, 1 if success else 11)
                self.assertEqual([event[1] for event in run.events if event[0] == 'sleep' and event[2]],
                                 [] if success else [1] * 10)

    def test_native_only_disabled_or_nonwindows_has_no_diagnostic_side_effects(self):
        for options in [{'enabled': False, 'legacy': False}, {'platform': 'darwin'}, {'platform': 'linux'}]:
            with self.subTest(options=options):
                run = self.exercise_outcome(**options)
                run.constructors.assert_not_called()
                run.finds.assert_not_called()
                run.ancestries.assert_not_called()
                run.observations.assert_not_called()
                run.gui.position.assert_not_called()
                self.assertEqual(run.gui.screenshot.call_count, 3)
                self.assertFalse([event for event in run.events if event[0] == 'sleep' and event[2]])

    def test_native_only_rejects_a_window_outside_the_launched_process_tree(self):
        run = self.exercise_outcome(ownership=False)
        self.assertEqual(run.finds.call_count, 1)
        self.assertEqual(run.ancestries.call_count, 1)
        self.assertTrue(run.result['diagnosticErrors'])
        self.assertEqual(run.gui.screenshot.call_count, 3)
        self.assertFalse([event for event in run.events if event[0] == 'sleep' and event[2]])

    def test_native_only_reused_hwnd_never_redirects_samples_or_crops_another_process(self):
        run = self.exercise_outcome(reused=True)
        self.assertEqual(run.finds.call_count, 1)
        self.assertEqual(run.user.FindWindowW.call_count, 1)
        self.assertEqual(run.observations.call_args_list, [unittest.mock.call(run.handle)] * 11)
        self.assertEqual(run.gui.size.call_count, 3, 'only original assertion screenshots may be cropped')
        self.assertTrue(all(not row['sameOriginalWindow'] for row in run.result['windowReadings'][1:]))

    def test_native_only_rejects_pid_reuse_between_discovery_and_the_first_state_read(self):
        run = self.exercise_outcome(initial_reused=True)
        self.assertEqual(run.finds.call_count, 1)
        self.assertEqual(run.ancestries.call_count, 1)
        self.assertEqual(run.observations.call_args_list, [unittest.mock.call(run.handle)])
        self.assertEqual(run.gui.screenshot.call_count, 3)
        self.assertFalse([event for event in run.events if event[0] == 'sleep' and event[2]])
        self.assertTrue(run.result['diagnosticErrors'])
        self.assertFalse(run.result['windowReadings'][0]['sameOriginalWindow'])
        self.assertEqual(run.result['windowReadings'][0]['originalPid'], 77)
        self.assertEqual(run.result['windowReadings'][0]['pid'], 88)

    def test_post_failure_observation_stops_when_its_remaining_time_cannot_cover_another_wait(self):
        from PIL import Image
        clock = [0.0]
        state = {'hwnd': 123, 'pid': 77, 'isWindow': True, 'visible': True, 'bounds': [0, 0, 2, 2]}
        gui = Mock()
        gui.size.return_value = SimpleNamespace(width=2)
        def screenshot():
            clock[0] += 0.25
            return Image.new('RGB', (2, 2))
        def sleep(seconds):
            clock[0] += seconds
        gui.screenshot.side_effect = screenshot
        with tempfile.TemporaryDirectory() as directory:
            result = {'ok': False, 'error': 'original assertion'}
            diagnostic = desktop.WindowsWindowDiagnostics(Path(directory), result)
            diagnostic.handle, diagnostic.pid = 123, 77
            shots = []
            with patch.object(desktop.time, 'monotonic', side_effect=lambda: clock[0]), \
                    patch.object(desktop.time, 'sleep', side_effect=sleep) as sleeps, \
                    patch.object(desktop, 'windows_window_state', return_value=state) as observations:
                diagnostic.after_failure(gui, shots, samples=10, deadline=2.75)
            self.assertEqual([call.args for call in sleeps.call_args_list], [(1,), (1,)])
            self.assertEqual(observations.call_args_list, [unittest.mock.call(123)] * 2)
            self.assertEqual(gui.screenshot.call_count, 2)
            self.assertEqual(len(shots), 2)
            self.assertLessEqual(clock[0], 2.75)
            self.assertEqual((result['ok'], result['error']), (False, 'original assertion'))


class WindowsThreadDiagnosticTests(unittest.TestCase):
    def enumerate_threads(self, records, *, children=False, cycle=False):
        from ctypes import wintypes
        parent = 0x1234567887654000
        handles = [row[0] for row in records]
        owners = {row[0]: row[1:] for row in records}
        sequence = handles + ([handles[0]] if cycle else [0])
        def owner(handle, pointer):
            pid, thread_id = owners[handle]
            pointer._obj.value = pid
            return thread_id
        user = SimpleNamespace(FindWindowExW=Mock(side_effect=sequence),
                               GetWindowThreadProcessId=Mock(side_effect=owner))
        with patch.object(ctypes, 'windll', SimpleNamespace(user32=user), create=True):
            result = desktop.windows_child_threads(77, 99, parent) if children else desktop.windows_dispatcher_threads(77, 99)
        expected_parent = parent if children else ctypes.c_void_p(-3).value
        expected_class = 'ContainerViewClass' if children else 'MessageWindowClass'
        for index, call in enumerate(user.FindWindowExW.call_args_list):
            actual_parent, previous, class_name, title = call.args
            self.assertEqual(actual_parent.value, expected_parent)
            self.assertEqual(previous, 0 if index == 0 else handles[index - 1])
            self.assertEqual(class_name, expected_class)
            self.assertIsNone(title)
        self.assertIs(user.FindWindowExW.restype, wintypes.HWND)
        self.assertEqual(user.GetWindowThreadProcessId.argtypes,
                         [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)])
        return result, user

    def test_dispatcher_and_direct_child_reads_filter_pid_and_preserve_full_hwnd(self):
        base = 0x1234567887654321
        records = [(base, 77, 99), (base + 1, 88, 99), (base + 2, 77, 100)]
        for children in (False, True):
            with self.subTest(children=children):
                result, user = self.enumerate_threads(records, children=children)
                windows = result['children' if children else 'dispatchers']
                self.assertEqual([window['hwnd'] for window in windows], [base, base + 2])
                self.assertEqual([window['pid'] for window in windows], [77, 77])
                self.assertEqual([window['threadId'] for window in windows], [99, 100])
                self.assertEqual(result['windowsExamined'], 3)
                self.assertFalse(result['truncated'])
                self.assertFalse(result['cycleDetected'])
                self.assertEqual(user.FindWindowExW.call_count, 4)
                if children:
                    self.assertTrue(result['childFound'])
                    self.assertFalse(result['allChildrenMatchWindowThread'])
                else:
                    self.assertTrue(result['windowThreadMatchesDispatcher'])

    def test_foreign_process_threads_cannot_establish_a_match(self):
        for children in (False, True):
            with self.subTest(children=children):
                result, _ = self.enumerate_threads([(123, 88, 99)], children=children)
                self.assertEqual(result['children' if children else 'dispatchers'], [])
                self.assertIsNone(result['allChildrenMatchWindowThread' if children else 'windowThreadMatchesDispatcher'])
                if children:
                    self.assertFalse(result['childFound'])

    def test_window_thread_enumeration_caps_native_reads_even_when_more_windows_exist(self):
        records = [(1000 + i, 77, 99) for i in range(65)]
        for children in (False, True):
            with self.subTest(children=children):
                result, user = self.enumerate_threads(records, children=children)
                self.assertEqual(user.FindWindowExW.call_count, 64)
                self.assertEqual(user.GetWindowThreadProcessId.call_count, 64)
                self.assertEqual(result['windowsExamined'], 64)
                self.assertTrue(result['truncated'])
                self.assertFalse(result['cycleDetected'])
                self.assertEqual(len(result['children' if children else 'dispatchers']), 64)

    def test_window_thread_enumeration_stops_on_a_cycle_without_rereading_the_owner(self):
        for children in (False, True):
            with self.subTest(children=children):
                result, user = self.enumerate_threads([(123, 77, 99), (456, 77, 100)],
                                                     children=children, cycle=True)
                self.assertEqual(user.FindWindowExW.call_count, 3)
                self.assertEqual(user.GetWindowThreadProcessId.call_count, 2)
                self.assertEqual(result['windowsExamined'], 2)
                self.assertTrue(result['truncated'])
                self.assertTrue(result['cycleDetected'])

    def test_process_thread_snapshot_is_bounded_hidden_and_labels_creation_order_as_inference(self):
        threads = [{'threadId': 100, 'startTimeUtc': '2026-10-22T01:02:04Z'},
                   {'threadId': 98, 'startTimeUtc': None, 'error': 'StartTime unavailable'},
                   {'threadId': 99, 'startTimeUtc': '2026-10-22T01:02:03Z'}]
        payload = {'pid': 77, 'threads': threads, 'totalThreads': 3, 'truncated': False}
        with patch.object(desktop.subprocess, 'run', return_value=SimpleNamespace(stdout=json.dumps(payload))) as run:
            snapshot = desktop.windows_thread_snapshot(77, 99)
        run.assert_called_once()
        args, kwargs = run.call_args
        command = args[0]
        self.assertEqual(command[:5], ['powershell', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command'])
        self.assertIn('Get-Process -Id 77 ', command[5])
        self.assertRegex(command[5], r'Select-Object\s+-First\s+256\b')
        self.assertEqual(kwargs, {'capture_output': True, 'text': True, 'check': True,
                                  'timeout': 3, 'creationflags': 0x08000000})
        self.assertEqual(snapshot['threads'], threads)
        self.assertEqual(snapshot['earliestObservedThreadId'], 99)
        self.assertTrue(snapshot['windowThreadMatchesEarliestObserved'])
        self.assertIn('candidate', snapshot['inference'])
        self.assertIn('missing or terminated', snapshot['inference'])

    def test_missing_thread_start_times_leave_creation_order_unknown(self):
        payload = {'pid': 77, 'threads': [{'threadId': 99, 'startTimeUtc': None, 'error': 'access denied'}]}
        with patch.object(desktop.subprocess, 'run', return_value=SimpleNamespace(stdout=json.dumps(payload))):
            snapshot = desktop.windows_thread_snapshot(77, 99)
        self.assertIsNone(snapshot['earliestObservedThreadId'])
        self.assertIsNone(snapshot['windowThreadMatchesEarliestObserved'])

    def test_process_thread_timeout_and_command_errors_propagate_without_retry(self):
        for error in (subprocess.TimeoutExpired('powershell', 3),
                      subprocess.CalledProcessError(1, 'powershell', stderr='process exited')):
            with self.subTest(error=type(error).__name__), \
                    patch.object(desktop.subprocess, 'run', side_effect=error) as run:
                with self.assertRaises(type(error)) as raised:
                    desktop.windows_thread_snapshot(77, 99)
                self.assertIs(raised.exception, error)
                run.assert_called_once()
                self.assertEqual(run.call_args.kwargs['timeout'], 3)
                self.assertEqual(run.call_args.kwargs['creationflags'], 0x08000000)

    def test_process_thread_snapshot_rejects_bad_json_wrong_pid_and_wrong_shape(self):
        for payload, error in [('not json', json.JSONDecodeError),
                               ('[]', RuntimeError),
                               (json.dumps({'pid': 88, 'threads': []}), RuntimeError),
                               (json.dumps({'pid': 77, 'threads': {}}), RuntimeError)]:
            with self.subTest(payload=payload), \
                    patch.object(desktop.subprocess, 'run', return_value=SimpleNamespace(stdout=payload)):
                with self.assertRaises(error):
                    desktop.windows_thread_snapshot(77, 99)


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
