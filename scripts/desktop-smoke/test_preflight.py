"""Preflight geometry and input checks without opening a real desktop window."""
from collections import namedtuple
from contextlib import nullcontext
from copy import deepcopy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from PIL import Image

import preflight


SCREEN = (640, 480)
FAILSAFE_POINTS = [(0, 0), (639, 0), (0, 479), (639, 479)]


def visible_geometry():
    return {
        'root': {'mapped': True, 'viewable': True, 'x': 100, 'y': 100,
                 'width': 400, 'height': 240},
        'button': {'mapped': True, 'viewable': True, 'x': 180, 'y': 180,
                   'width': 120, 'height': 40},
    }


class ReadyTargetTests(unittest.TestCase):
    def test_valid_geometry_returns_one_integer_center(self):
        geometry = visible_geometry()
        geometry['button'].update(width=121, height=41)
        target = preflight.ready_target(geometry, SCREEN, FAILSAFE_POINTS)
        self.assertEqual(target, (240, 200))
        self.assertIsInstance(target, tuple)
        self.assertTrue(all(type(coordinate) is int for coordinate in target))

    def test_unmapped_unviewable_and_unlaid_out_widgets_are_not_ready(self):
        for widget in ('root', 'button'):
            for key, value in [('mapped', False), ('viewable', False),
                               ('width', 1), ('height', 1),
                               ('width', 0), ('height', -1)]:
                with self.subTest(widget=widget, key=key, value=value):
                    geometry = visible_geometry()
                    geometry[widget][key] = value
                    self.assertIsNone(preflight.ready_target(geometry, SCREEN, FAILSAFE_POINTS))

    def test_target_must_be_strictly_inside_root_and_screen(self):
        # Each case keeps the button's dimensions usable but moves its center
        # onto or beyond one required boundary.
        cases = [
            ('root-left-edge', {'x': 40}, None),
            ('root-right-edge', {'x': 440}, None),
            ('root-top-edge', {'y': 80}, None),
            ('root-bottom-edge', {'y': 320}, None),
            ('screen-left-edge', {'x': -60}, {'x': -100}),
            ('screen-top-edge', {'y': -20}, {'y': -100}),
            ('screen-right-edge', {'x': 579}, {'x': 500}),
            ('screen-bottom-edge', {'y': 459}, {'y': 400}),
            ('offscreen-left', {'x': -80}, {'x': -100}),
            ('offscreen-bottom', {'y': 500}, {'y': 400}),
        ]
        for name, button_changes, root_changes in cases:
            with self.subTest(case=name):
                geometry = visible_geometry()
                geometry['button'].update(button_changes)
                if root_changes:
                    geometry['root'].update(root_changes)
                self.assertIsNone(preflight.ready_target(geometry, SCREEN, FAILSAFE_POINTS))

    def test_valid_center_cannot_be_a_configured_failsafe_point(self):
        self.assertIsNone(preflight.ready_target(visible_geometry(), SCREEN,
                                                FAILSAFE_POINTS + [(240, 200)]))


class FakeClock:
    def __init__(self):
        self.now = 0.0

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now = round(self.now + seconds, 9)
        if self.now > 20:
            raise AssertionError('Preflight exceeded its bounded readiness and click deadlines')


class FakeWidget:
    def __init__(self, environment, name):
        self.environment = environment
        self.name = name
        self.title = Mock()
        self.geometry = Mock()
        self.configure = Mock()
        self.attributes = Mock()
        self.pack = Mock()
        self.destroy = Mock()

    def field(self, name):
        return self.environment.geometry()[self.name][name]

    def winfo_ismapped(self):
        return self.field('mapped')

    def winfo_viewable(self):
        return self.field('viewable')

    def winfo_rootx(self):
        return self.field('x')

    def winfo_rooty(self):
        return self.field('y')

    def winfo_width(self):
        return self.field('width')

    def winfo_height(self):
        return self.field('height')

    def update(self):
        self.environment.updates.append(self.environment.clock.now)
        if self.environment.pending_click:
            self.environment.pending_click = False
            self.environment.command()


class FailsafeGui(SimpleNamespace):
    def __setattr__(self, name, value):
        if name == 'FAILSAFE' and value is not True:
            raise AssertionError('Preflight must keep the PyAutoGUI failsafe enabled')
        super().__setattr__(name, value)


class FakeDesktop:
    def __init__(self, ready_at=0, deliver_click=True, pixel_color=(19, 201, 87),
                 mutate_on_move=False, cursor=(0, 0)):
        self.clock = FakeClock()
        self.ready_at = ready_at
        self.deliver_click = deliver_click
        self.mutate_on_move = mutate_on_move
        self.cursor = cursor
        self.current_geometry = visible_geometry()
        self.events = []
        self.updates = []
        self.pending_click = False
        self.command = None
        self.root = FakeWidget(self, 'root')
        self.button = FakeWidget(self, 'button')
        self.tk = SimpleNamespace(Tk=Mock(return_value=self.root), Button=Mock(side_effect=self.make_button))
        size = namedtuple('Size', 'width height')(*SCREEN)
        self.gui = FailsafeGui(
            FAILSAFE=True, FAILSAFE_POINTS=list(FAILSAFE_POINTS),
            size=Mock(return_value=size), position=Mock(side_effect=lambda: self.cursor),
            click=Mock(side_effect=self.click),
            screenshot=Mock(return_value=Image.new('RGB', SCREEN, pixel_color)),
        )

    def geometry(self):
        if self.clock.now >= self.ready_at:
            return deepcopy(self.current_geometry)
        # Model a mapped but not yet laid-out Tk window.
        return {name: {'mapped': True, 'viewable': True, 'x': 0, 'y': 0,
                       'width': 1, 'height': 1} for name in ('root', 'button')}

    def make_button(self, root, text, command):
        if root is not self.root:
            raise AssertionError('Preflight button must belong to its visible probe')
        self.command = command
        return self.button

    def record(self, action, target):
        self.events.append({'action': action, 'target': tuple(target),
                            'time': self.clock.now, 'geometry': self.geometry()})

    def move(self, command, **kwargs):
        if command[:3] != ['xdotool', 'mousemove', '--sync'] or kwargs != {'check': True, 'timeout': 3}:
            raise AssertionError(f'Unexpected desktop command: {command!r} {kwargs!r}')
        target = tuple(int(value) for value in command[3:])
        self.record('xdotool', target)
        self.cursor = target
        if self.mutate_on_move:
            # Native geometry can change between reads; input must still use
            # the one integer center that passed readiness validation.
            self.current_geometry['button']['x'] += 70
        return SimpleNamespace(returncode=0)

    def click(self, *target):
        self.record('click', target)
        self.cursor = target
        self.pending_click = self.deliver_click


class PreflightIntegrationTests(unittest.TestCase):
    def exercise(self, environment, failure=None, exception=AssertionError,
                 platform='linux', diagnostics=None):
        raised = None
        diagnostic_mock = Mock(return_value={'exitCode': 0, 'stdout': 'foreground snapshot'})
        if diagnostics is not None:
            diagnostic_mock.side_effect = diagnostics
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(sys.modules, {'tkinter': environment.tk, 'pyautogui': environment.gui}), \
                    patch.object(preflight.sys, 'platform', platform), \
                    patch.object(preflight, 'capture_failure_diagnostics', diagnostic_mock), \
                    patch.object(preflight.time, 'monotonic', side_effect=environment.clock.monotonic), \
                    patch.object(preflight.time, 'sleep', side_effect=environment.clock.sleep), \
                    patch.object(preflight.subprocess, 'run', side_effect=environment.move), \
                    patch('builtins.print'):
                if failure:
                    with self.assertRaisesRegex(exception, failure) as caught:
                        preflight.main([directory])
                    raised = caught.exception
                else:
                    preflight.main([directory])
            self.assertTrue(environment.gui.FAILSAFE)
            environment.root.destroy.assert_called_once()
            state_file = Path(directory) / 'preflight-state.json'
            state = json.loads(state_file.read_text()) if state_file.exists() else None
            return SimpleNamespace(state=state,
                                   exception=raised,
                                   diagnostics=diagnostic_mock,
                                   screenshot_exists=(Path(directory) / 'desktop-preflight.png').exists())

    def test_delayed_geometry_receives_no_input_until_ready(self):
        environment = FakeDesktop(ready_at=4.25)
        result = self.exercise(environment)
        self.assertEqual([event['action'] for event in environment.events], ['xdotool', 'click'])
        for event in environment.events:
            self.assertGreaterEqual(event['time'], 4.25)
            self.assertLess(event['time'], 10)
            self.assertEqual(preflight.ready_target(event['geometry'], SCREEN, FAILSAFE_POINTS), event['target'])
        self.assertTrue(result.screenshot_exists)
        self.assertGreater(len(environment.updates), 3)

    def test_ready_geometry_preserves_original_three_second_pumping(self):
        environment = FakeDesktop(cursor=(300, 200))
        self.exercise(environment)
        self.assertEqual([event['action'] for event in environment.events], ['click'])
        self.assertGreaterEqual(environment.events[0]['time'], 3)
        self.assertLess(environment.events[0]['time'], 3.1)

    def test_never_ready_times_out_without_input_or_capture(self):
        environment = FakeDesktop(ready_at=float('inf'))
        result = self.exercise(environment, failure='within 10 seconds')
        self.assertEqual(environment.events, [])
        environment.gui.click.assert_not_called()
        environment.gui.screenshot.assert_not_called()
        self.assertGreaterEqual(environment.clock.now, 10)
        self.assertLessEqual(environment.clock.now, 10.1)
        self.assertIsNotNone(result.state, 'Timeout must preserve the geometry evidence')
        self.assertIsNone(result.state['target'])
        self.assertEqual(result.state['candidateTarget'], [0, 0])
        self.assertTrue(result.state['error'])
        self.assertFalse(result.screenshot_exists)

    def test_geometry_ready_at_or_after_the_deadline_receives_no_input(self):
        for ready_at in (10, 10.05):
            with self.subTest(ready_at=ready_at):
                environment = FakeDesktop(ready_at=ready_at)
                result = self.exercise(environment, failure='within 10 seconds')
                self.assertEqual(environment.events, [])
                environment.gui.click.assert_not_called()
                environment.gui.screenshot.assert_not_called()
                self.assertEqual(environment.clock.now, 10)
                self.assertIsNone(result.state['target'])

    def test_xdotool_and_click_reuse_the_same_frozen_integer_center(self):
        environment = FakeDesktop(mutate_on_move=True)
        self.exercise(environment)
        self.assertEqual([event['target'] for event in environment.events], [(240, 200), (240, 200)])
        self.assertNotEqual(environment.events[0]['geometry'], environment.events[1]['geometry'])
        self.assertTrue(all(type(value) is int for event in environment.events for value in event['target']))

    def test_real_click_callback_is_still_required(self):
        environment = FakeDesktop(deliver_click=False)
        result = self.exercise(environment, failure='Desktop did not deliver a real mouse click')
        self.assertEqual([event['action'] for event in environment.events], ['xdotool', 'click'])
        environment.gui.screenshot.assert_not_called()
        self.assertGreaterEqual(environment.clock.now, 6)
        self.assertLessEqual(environment.clock.now, 6.1)
        self.assertFalse(result.screenshot_exists)

    def test_visible_probe_pixel_proof_is_still_required(self):
        environment = FakeDesktop(pixel_color=(255, 0, 0))
        result = self.exercise(environment, failure='Desktop capture does not contain the visible probe')
        environment.gui.click.assert_called_once()
        environment.gui.screenshot.assert_called_once()
        self.assertTrue(result.screenshot_exists)

    def test_macos_failure_snapshot_cannot_turn_a_missing_click_into_success(self):
        environment = FakeDesktop(deliver_click=False, cursor=(300, 200))
        result = self.exercise(environment, platform='darwin',
                               failure='Desktop did not deliver a real mouse click')
        result.diagnostics.assert_called_once()
        environment.gui.click.assert_called_once_with(240, 200)
        environment.gui.screenshot.assert_not_called()
        self.assertEqual(result.state['status'], 'failed')
        self.assertEqual(result.state['failureDiagnostics']['exitCode'], 0)
        self.assertFalse(result.screenshot_exists)

    def test_macos_success_does_not_run_diagnostics(self):
        result = self.exercise(FakeDesktop(cursor=(300, 200)), platform='darwin')
        result.diagnostics.assert_not_called()
        self.assertNotIn('failureDiagnostics', result.state)

    def test_macos_diagnostic_failure_preserves_original_input_exception(self):
        original = RuntimeError('original input failure')
        environment = FakeDesktop(cursor=(300, 200))
        environment.gui.click.side_effect = original
        result = self.exercise(environment, platform='darwin', exception=RuntimeError,
                               failure='original input failure', diagnostics=OSError('capture failed'))
        self.assertIs(result.exception, original)
        self.assertEqual(result.state['error'], 'RuntimeError: original input failure')
        self.assertEqual(result.state['failureDiagnostics']['error'], 'OSError: capture failed')
        environment.gui.click.assert_called_once()

    def test_failsafe_exception_propagates_without_retry(self):
        class FailSafeException(Exception):
            pass

        environment = FakeDesktop()
        environment.gui.click.side_effect = FailSafeException('PyAutoGUI fail-safe triggered')
        result = self.exercise(environment, failure='PyAutoGUI fail-safe triggered', exception=FailSafeException)
        environment.gui.click.assert_called_once_with(240, 200)
        self.assertEqual([event['action'] for event in environment.events], ['xdotool'])
        environment.gui.screenshot.assert_not_called()
        self.assertEqual(result.state['status'], 'failed')
        self.assertIn('FailSafeException', result.state['error'])

    def test_diagnostic_write_or_destroy_failure_preserves_original_failsafe(self):
        class FailSafeException(Exception):
            pass

        for secondary_failure in ('state-write', 'destroy'):
            with self.subTest(secondary_failure=secondary_failure):
                environment = FakeDesktop()
                original = FailSafeException('original PyAutoGUI fail-safe')
                environment.gui.click.side_effect = original
                if secondary_failure == 'destroy':
                    environment.root.destroy.side_effect = OSError('destroy failed')
                write_patch = (patch.object(Path, 'write_text', side_effect=OSError('state write failed'))
                               if secondary_failure == 'state-write' else nullcontext())
                with write_patch:
                    result = self.exercise(environment, failure='original PyAutoGUI fail-safe',
                                           exception=FailSafeException)
                self.assertIs(result.exception, original)
                environment.gui.click.assert_called_once_with(240, 200)
                environment.gui.screenshot.assert_not_called()


class FailureDiagnosticTests(unittest.TestCase):
    def test_macos_snapshot_only_observes_focus_and_captures_after_flushing_evidence(self):
        frontmost = SimpleNamespace(processIdentifier=lambda: 123, localizedName=lambda: 'Python',
                                    bundleIdentifier=lambda: 'org.python.python')
        probe = SimpleNamespace(isActive=lambda: True, isHidden=lambda: False)
        lookup = Mock(return_value=probe)
        appkit = SimpleNamespace(
            NSWorkspace=SimpleNamespace(sharedWorkspace=lambda: SimpleNamespace(frontmostApplication=lambda: frontmost)),
            NSRunningApplication=SimpleNamespace(runningApplicationWithProcessIdentifier_=lookup))
        evidence = []
        def capture(command, **kwargs):
            self.assertEqual(command, ['/usr/sbin/screencapture', '-x',
                                       str(Path('/tmp/probe-output') / 'desktop-preflight-failure.png')])
            self.assertEqual(kwargs, {'check': True, 'timeout': 3})
            self.assertEqual(evidence[0]['frontmostApplication']['pid'], 123)
            self.assertEqual(evidence[0]['probeApplication'], {'active': True, 'hidden': False})
        with patch.dict(sys.modules, {'AppKit': appkit, 'tkinter': SimpleNamespace(TkVersion=8.6, TclVersion=8.6)}), \
                patch('importlib.metadata.version', return_value='test-version'), \
                patch.object(preflight.subprocess, 'run', side_effect=capture), \
                patch('builtins.print', side_effect=lambda text, **kwargs: evidence.append(json.loads(text))):
            preflight.macos_failure_snapshot('/tmp/probe-output', 456)
        lookup.assert_called_once_with(456)
        self.assertEqual(evidence[0]['probePid'], 456)
        self.assertEqual(evidence[0]['PyAutoGUI'], 'test-version')

    def test_snapshot_uses_a_bounded_isolated_child_and_caps_log_output(self):
        result = SimpleNamespace(returncode=1, stdout='x' * 10000, stderr='y' * 10000)
        with patch.object(preflight.subprocess, 'run', return_value=result) as run:
            snapshot = preflight.capture_failure_diagnostics(Path('/tmp/probe-output'))
        command = run.call_args.args[0]
        self.assertEqual(command, [sys.executable, str(Path(preflight.__file__).resolve()),
                                   '--failure-diagnostics', str(Path('/tmp/probe-output')), str(os.getpid())])
        self.assertEqual(run.call_args.kwargs, {'capture_output': True, 'text': True, 'timeout': 8})
        self.assertEqual(snapshot['exitCode'], 1)
        self.assertEqual(len(snapshot['stdout']), 4096)
        self.assertEqual(len(snapshot['stderr']), 2048)

    def test_stalled_child_records_timeout_and_keeps_flushed_focus_evidence(self):
        timeout = subprocess.TimeoutExpired(['diagnostic'], 8, output=b'{"probeActive":false}\n')
        with patch.object(preflight.subprocess, 'run', side_effect=timeout):
            snapshot = preflight.capture_failure_diagnostics(Path('/tmp/probe-output'))
        self.assertIn('TimeoutExpired', snapshot['error'])
        self.assertEqual(snapshot['stdout'], '{"probeActive":false}\n')


if __name__ == '__main__':
    unittest.main()
