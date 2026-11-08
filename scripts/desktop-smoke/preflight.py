"""Fail quickly if the hosted desktop cannot capture pixels or receive input."""
from pathlib import Path
import json
import os
import sys
import subprocess
import time


def macos_failure_snapshot(output, probe_pid):
    """Read desktop state in an isolated process; never activate or send input."""
    import platform
    from importlib.metadata import version
    import tkinter as tk

    snapshot = {'python': sys.version, 'macOS': platform.mac_ver()[0],
                'machine': platform.machine(), 'tk': tk.TkVersion,
                'tcl': tk.TclVersion, 'probePid': probe_pid}
    for package in ('PyAutoGUI', 'Pillow', 'pyobjc-core', 'pyobjc-framework-Cocoa',
                    'pyobjc-framework-Quartz'):
        try:
            snapshot[package] = version(package)
        except Exception as error:
            snapshot[package] = f'{type(error).__name__}: {error}'
    try:
        import AppKit
        frontmost = AppKit.NSWorkspace.sharedWorkspace().frontmostApplication()
        if frontmost:
            snapshot['frontmostApplication'] = {
                'pid': frontmost.processIdentifier(), 'name': frontmost.localizedName(),
                'bundleId': frontmost.bundleIdentifier()}
        probe = AppKit.NSRunningApplication.runningApplicationWithProcessIdentifier_(probe_pid)
        if probe:
            snapshot['probeApplication'] = {'active': bool(probe.isActive()),
                                            'hidden': bool(probe.isHidden())}
    except Exception as error:
        snapshot['focusError'] = f'{type(error).__name__}: {error}'
    # Preserve focus/version evidence even if the native capture hangs. The
    # parent bounds the entire child as well as this individual command.
    print(json.dumps(snapshot, sort_keys=True), flush=True)
    subprocess.run(['/usr/sbin/screencapture', '-x', str(Path(output) / 'desktop-preflight-failure.png')],
                   check=True, timeout=3)


def capture_failure_diagnostics(output):
    try:
        result = subprocess.run([sys.executable, str(Path(__file__).resolve()),
                                 '--failure-diagnostics', str(output), str(os.getpid())],
                                capture_output=True, text=True, timeout=8)
        return {'exitCode': result.returncode, 'stdout': result.stdout[:4096],
                'stderr': result.stderr[:2048]}
    except Exception as error:
        # TimeoutExpired may include the flushed focus snapshot. This evidence
        # cannot replace the original input/capture failure or extend its budget.
        partial = getattr(error, 'stdout', None) or b''
        if isinstance(partial, bytes):
            partial = partial.decode('utf-8', errors='replace')
        return {'error': f'{type(error).__name__}: {error}'[:2048], 'stdout': partial[:4096]}


def capture_geometry(root, button):
    return {name: {'mapped': bool(widget.winfo_ismapped()),
                   'viewable': bool(widget.winfo_viewable()),
                   'x': widget.winfo_rootx(), 'y': widget.winfo_rooty(),
                   'width': widget.winfo_width(), 'height': widget.winfo_height()}
            for name, widget in [('root', root), ('button', button)]}


def ready_target(geometry, screen, failsafe_points):
    """Return one validated integer click target from a single layout snapshot."""
    root, button = geometry['root'], geometry['button']
    for widget in (root, button):
        if not (widget['mapped'] and widget['viewable'] and
                widget['width'] > 1 and widget['height'] > 1):
            return None
    target = (button['x'] + button['width'] // 2,
              button['y'] + button['height'] // 2)
    x, y = target
    if not (0 < x < screen[0] - 1 and 0 < y < screen[1] - 1):
        return None
    if target in failsafe_points:
        return None
    for widget in (root, button):
        if not (widget['x'] < x < widget['x'] + widget['width'] and
                widget['y'] < y < widget['y'] + widget['height']):
            return None
    return target


def main(argv=None):
    import tkinter as tk
    import pyautogui as gui
    from PIL import ImageStat

    output = Path((sys.argv[1:] if argv is None else argv)[0])
    output.mkdir(parents=True, exist_ok=True)
    root = tk.Tk()
    root.title('Electrobun smoke desktop preflight')
    root.geometry('400x240+100+100')
    root.configure(background='#13c957')
    root.attributes('-topmost', True)
    clicked = []
    button = tk.Button(root, text='Verify input', command=lambda: clicked.append(True))
    button.pack(padx=80, pady=80)
    state = {'status': 'waiting-for-layout', 'target': None}
    try:
        started = time.monotonic()
        deadline = started + 10
        while True:
            root.update()
            state['geometry'] = capture_geometry(root, button)
            state['screen'] = tuple(gui.size())
            button_geometry = state['geometry']['button']
            state['candidateTarget'] = (button_geometry['x'] + button_geometry['width'] // 2,
                                        button_geometry['y'] + button_geometry['height'] // 2)
            target = ready_target(state['geometry'], state['screen'], gui.FAILSAFE_POINTS)
            now = time.monotonic()
            if now >= deadline:
                raise AssertionError('Desktop preflight has no mapped interior click target within 10 seconds')
            # Preserve the original initial event-pump period for compositing,
            # but require mapped geometry before clicking a delayed Tk window.
            if target is not None and now - started >= 3:
                state['target'] = target
                state['layoutElapsedSeconds'] = now - started
                break
            time.sleep(0.05)
        state['cursorBeforeInput'] = tuple(gui.position())
        # Fresh Xvfb sessions can leave the pointer in an emergency-stop
        # corner. Initialize it without disabling PyAutoGUI's failsafe.
        if sys.platform == 'linux' and state['cursorBeforeInput'] in gui.FAILSAFE_POINTS:
            subprocess.run(['xdotool', 'mousemove', '--sync', str(target[0]), str(target[1])],
                           check=True, timeout=3)
        state['status'] = 'clicking'
        # Reuse the exact integer target validated above. A new geometry read
        # here could otherwise turn an unmapped 1x1 widget into a (0, 0) click.
        gui.click(*target)
        state['cursorAfterInput'] = tuple(gui.position())
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and not clicked:
            root.update()
            time.sleep(0.05)
        assert clicked, 'Desktop did not deliver a real mouse click'
        image = gui.screenshot()
        image.save(output / 'desktop-preflight.png')
        scale = image.width / gui.size().width
        x, y = root.winfo_rootx() + 20, root.winfo_rooty() + 20
        pixels = image.crop(tuple(round(v * scale) for v in (x, y, x + 10, y + 10)))
        rgb = ImageStat.Stat(pixels.convert('RGB')).mean
        state['sampledRgb'] = rgb
        assert max(abs(actual - expected) for actual, expected in zip(rgb, (19, 201, 87))) < 8, f'Desktop capture does not contain the visible probe: {rgb}'
        state['status'] = 'passed'
        print('Desktop capture and native mouse input passed')
    except Exception as error:
        state['status'] = 'failed'
        state['error'] = f'{type(error).__name__}: {error}'
        raise
    finally:
        # Telemetry must not replace the original exception or the real
        # callback/pixel proofs with a successful diagnostic observation.
        original_error = sys.exc_info()[1]
        if original_error is not None and sys.platform == 'darwin':
            try:
                state['failureDiagnostics'] = capture_failure_diagnostics(output)
            except Exception as error:
                state['failureDiagnostics'] = {'error': f'{type(error).__name__}: {error}'}
        try:
            state['finalGeometry'] = capture_geometry(root, button)
            state['finalCursor'] = tuple(gui.position())
        except Exception as error:
            state['telemetryError'] = f'{type(error).__name__}: {error}'
        try:
            (output / 'preflight-state.json').write_text(json.dumps(state, indent=2) + '\n')
            print(json.dumps(state, sort_keys=True))
        except Exception:
            if original_error is None:
                raise
        finally:
            try:
                root.destroy()
            except Exception:
                if original_error is None:
                    raise


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == '--failure-diagnostics':
        macos_failure_snapshot(sys.argv[2], int(sys.argv[3]))
    else:
        main()
