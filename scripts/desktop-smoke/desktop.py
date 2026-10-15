"""Desktop-level smoke checks. Never substitutes a DOM capture for visible pixels."""
import ctypes
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time


def window(title, activate=True):
    if sys.platform == 'darwin':
        import Quartz
        import AppKit
        for item in Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionOnScreenOnly, 0):
            if item.get('kCGWindowName') == title:
                bounds = item['kCGWindowBounds']
                if activate:
                    AppKit.NSRunningApplication.runningApplicationWithProcessIdentifier_(item['kCGWindowOwnerPID']).activateWithOptions_(2)
                return tuple(int(bounds[k]) for k in ('X', 'Y', 'Width', 'Height'))
    elif sys.platform == 'win32':
        from ctypes import wintypes
        user = ctypes.windll.user32
        user.SetProcessDPIAware()
        user.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
        user.FindWindowW.restype = wintypes.HWND
        user.IsWindowVisible.argtypes = [wintypes.HWND]
        user.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
        user.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
        user.SetForegroundWindow.argtypes = [wintypes.HWND]
        handle = user.FindWindowW(None, title)
        if handle and user.IsWindowVisible(handle):
            rect = wintypes.RECT()
            if activate:
                user.ShowWindow(handle, 9 if title == "Bunny" or title.startswith("Electrobun UI") else 3)
            user.GetWindowRect(handle, ctypes.byref(rect))
            if activate:
                user.SetForegroundWindow(handle)
            return rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top
    else:
        found = subprocess.run(['xdotool', 'search', '--onlyvisible', '--name', '^' + re.escape(title) + '$'], capture_output=True, text=True)
        if found.returncode == 0:
            handle = found.stdout.splitlines()[-1]
            if activate:
                subprocess.run(['xdotool', 'windowactivate', '--sync', handle], check=True)
            geometry = subprocess.check_output(['xdotool', 'getwindowgeometry', '--shell', handle], text=True)
            values = dict(line.split('=', 1) for line in geometry.splitlines() if '=' in line)
            return tuple(int(values[k]) for k in ('X', 'Y', 'WIDTH', 'HEIGHT'))
    return None


def minimize_window(gui, title):
    bounds = window(title)
    if not bounds:
        return False
    if sys.platform == 'win32':
        user = ctypes.windll.user32
        user.ShowWindow(user.FindWindowW(None, title), 6)
    elif sys.platform == 'darwin':
        # Standard Cocoa titlebar's yellow button. Do this as soon as the
        # runner opens, before its delayed interactive playground starts.
        gui.click(bounds[0] + 34, bounds[1] + 14)
    else:
        handle = subprocess.check_output(['xdotool', 'search', '--onlyvisible', '--name',
                                          '^' + re.escape(title) + '$'], text=True).splitlines()[-1]
        subprocess.run(['xdotool', 'windowminimize', handle], check=True)
    return True


def stop(process):
    if sys.platform == 'win32':
        subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], capture_output=True)
    else:
        import signal
        try:
            # The Kitchen matrix owns detached app groups and forwards SIGTERM
            # to them. SIGKILL would strand CEF and lock its profile for the next app.
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=20)
        except ProcessLookupError:
            pass
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
    process.wait(timeout=20)


def counter_region(frame):
    return frame.crop((round(frame.width * 0.15), round(frame.height * 0.28),
                       round(frame.width * 0.45), round(frame.height * 0.50))).convert('RGB')


def counter_difference(initial, current):
    from PIL import ImageChops, ImageStat
    # Both tested states use the demo's purple counter accent. Require visible
    # glyph pixels so a disappearing counter cannot count as an increment.
    for frame in (initial, current):
        accent_pixels = sum(b > r + 20 and r > g + 20 and b > 110
                            for r, g, b in frame.getdata())
        if accent_pixels < 30:
            raise AssertionError('Counter glyph is missing or not rendered')
    return max(ImageStat.Stat(ImageChops.difference(initial, current)).mean)


def click_control(gui, point):
    gui.moveTo(*point)
    gui.mouseDown()
    try:
        # The native UI can poll mouse state once per render frame.
        time.sleep(0.15)
    finally:
        gui.mouseUp()


def double_click(gui, point):
    if sys.platform != 'darwin':
        gui.doubleClick(*point, interval=0.12)
        return
    # PyAutoGUI 0.9.54's macOS backend posts two independent single clicks.
    # Cocoa/CEF require the click-state field to identify the second click.
    import Quartz
    gui.moveTo(*point)
    for count in (1, 2):
        for event_type in (Quartz.kCGEventLeftMouseDown, Quartz.kCGEventLeftMouseUp):
            event = Quartz.CGEventCreateMouseEvent(None, event_type, point, Quartz.kCGMouseButtonLeft)
            Quartz.CGEventSetIntegerValueField(event, Quartz.kCGMouseEventClickState, count)
            Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)
            time.sleep(0.03)
        time.sleep(0.08)


def inspect_app(plan):
    import pyautogui as gui
    import pytesseract
    from PIL import ImageChops, ImageStat
    output = Path(plan['output'])
    output.mkdir(parents=True, exist_ok=True)
    if os.environ.get('SMOKE_TESSERACT'):
        pytesseract.pytesseract.tesseract_cmd = os.environ['SMOKE_TESSERACT']
    gui.PAUSE = 0.15
    shots = []
    checks = []
    result = {'name': plan['name'], 'ok': False, 'screenshots': shots, 'checks': checks}
    rect = None
    process = None

    def require_running():
        if process.poll() is not None:
            raise RuntimeError(f'dev command exited with {process.returncode}')
        # Watch mode can survive a fatal exception in the launched app.
        log_text = (output / 'dev.log').read_text(encoding='utf-8', errors='replace')
        if 'Uncaught exception in worker:' in log_text:
            raise RuntimeError('App worker crashed; see dev.log')

    def refresh_bounds():
        nonlocal rect
        current = window(plan['title'], activate=False)
        if not current:
            raise AssertionError('App window is no longer visible')
        rect = current

    def capture(label):
        refresh_bounds()
        image = gui.screenshot()
        label = f'{len(shots) + 1:02d}-{label}'
        image.save(output / f'{label}.png')
        shots.append(f'{label}.png')
        # Convert logical desktop coordinates to screenshot pixels (Retina).
        scale = image.width / gui.size().width
        x, y, w, h = rect
        box = tuple(round(n * scale) for n in (x, y, x + w, y + h))
        crop = image.crop(box)
        crop.save(output / f'{label}-window.png')
        return crop

    def ocr_regions(image):
        yield image, 0, '--psm 11'
        # Sparse-page OCR drops text inside filled buttons. Short overlapping
        # bands retain those labels without treating an animated GPU view as text.
        for top in range(0, image.height, 120):
            yield image.crop((0, top, image.width, min(top + 180, image.height))), top, '--psm 6'

    def text(image):
        return '\n'.join(pytesseract.image_to_string(region, config=config)
                         for region, _, config in ocr_regions(image))

    def await_text(expected, limit=45):
        deadline = time.monotonic() + limit
        last = ''
        while time.monotonic() < deadline:
            require_running()
            refresh_bounds()
            image = gui.screenshot()
            scale = image.width / gui.size().width
            x, y, w, h = rect
            image = image.crop(tuple(round(n * scale) for n in (x, y, x+w, y+h)))
            last = text(image)
            if ''.join(expected.casefold().split()) in ''.join(last.casefold().split()):
                return image
            time.sleep(1)
        raise AssertionError(f'Visible text {expected!r} not found. Last OCR: {last}')

    def locate_text(label, image=None, occurrence="first"):
        candidates = []
        if image is None:
            image = capture('target-' + re.sub(r'\W+', '-', label))
        for region, top, config in ocr_regions(image):
            data = pytesseract.image_to_data(region, config=config, output_type=pytesseract.Output.DICT)
            words = label.casefold().split()
            tokens = [word.casefold().strip().strip('.,;:!?') for word in data['text']]
            for start in range(len(tokens)):
                indices = []
                for i in range(start, len(tokens)):
                    if tokens[i]:
                        indices.append(i)
                    if len(''.join(tokens[j] for j in indices)) >= len(''.join(words)):
                        break
                if ''.join(tokens[i] for i in indices) == ''.join(words):
                    first, last = indices[0], indices[-1]
                    x = (data['left'][first] + data['left'][last] + data['width'][last]) / 2
                    y = top + data['top'][first] + data['height'][first] / 2
                    scale = gui.screenshot().width / gui.size().width
                    point = (rect[0] + x / scale, rect[1] + y / scale)
                    if occurrence == "first":
                        return point
                    candidates.append(point)
        if candidates:
            return max(candidates, key=lambda point: point[1])
        raise AssertionError(f'Could not locate clickable text {label!r}: {tokens}')

    try:
        with (output / 'dev.log').open('w', encoding='utf-8') as log:
            process = subprocess.Popen(plan['command'], cwd=plan['cwd'], env={**os.environ, **plan.get('env', {})},
                                       stdout=log, stderr=subprocess.STDOUT, start_new_session=sys.platform != 'win32')
            sibling_minimized = not plan.get('minimizeWindow')
            deadline = time.monotonic() + plan.get('startupTimeout', 600)
            while time.monotonic() < deadline:
                require_running()
                if not sibling_minimized:
                    sibling_minimized = minimize_window(gui, plan['minimizeWindow'])
                    if not sibling_minimized:
                        time.sleep(0.1)
                        continue
                    checks.append('minimized-test-runner')
                rect = window(plan['title'])
                if rect:
                    break
                time.sleep(1)
            if not rect:
                raise AssertionError(f'No visible window titled {plan["title"]!r}')
            checks.append('visible-window')
            # Maximize and the app's startup positioning can complete asynchronously.
            time.sleep(2)
            refresh_bounds()
            gui.moveTo(max(2, rect[0] - 20), max(2, rect[1] - 20))
            if plan.get('initialScrollHost'):
                await_text(plan['scrollReadyText'])
                # The right-hand host margin stays outside the 600px OOPIF.
                click_control(gui, (rect[0] + rect[2] * 0.9, rect[1] + rect[3] * 0.4))
                gui.scroll(plan['initialScrollHost'])
                time.sleep(1)
            if plan.get('readyText'):
                await_text(plan['readyText'])
                checks.append('rendered-ready-text')
            time.sleep(2)
            render_deadline = time.monotonic() + 30
            while True:
                require_running()
                before = capture('rendered')
                if max(ImageStat.Stat(before.convert('RGB')).stddev) >= 5:
                    break
                if time.monotonic() >= render_deadline:
                    raise AssertionError('Window capture remained blank or nearly uniform for 30 seconds')
                time.sleep(2)
            checks.append('nonblank-desktop-capture')
            initial_counter = counter_region(before)
            counter_changed = False
            result['windowBounds'] = list(rect)
            result['desktopSize'] = list(gui.size())
            last_click = None
            cursor_readings = []
            for index, action in enumerate(plan['actions']):
                refresh_bounds()
                if 'click' in action:
                    for label in [action['click'], *action.get('aliases', [])]:
                        try:
                            last_click = locate_text(label, occurrence=action.get('occurrence', 'first'))
                            break
                        except AssertionError:
                            if label == [action['click'], *action.get('aliases', [])][-1]:
                                raise
                    click_control(gui, last_click)
                if action.get('clickAgain'):
                    if last_click is None:
                        raise AssertionError('No previous control to click again')
                    click_control(gui, last_click)
                if 'doubleClick' in action:
                    point = locate_text(action['doubleClick'])
                    frame = capture('mask-before-selection')
                    scale = frame.width / rect[2]
                    x, y = (point[0] - rect[0]) * scale, (point[1] - rect[1]) * scale
                    box = tuple(round(v) for v in (x - 40 * scale, y - 14 * scale,
                                                  x + 40 * scale, y + 14 * scale))
                    def blue_coverage(image):
                        pixels = list(image.crop(box).convert('RGB').getdata())
                        return sum(b > r + 30 and b > 70 for r, g, b in pixels) / len(pixels)
                    baseline = blue_coverage(frame)
                    double_click(gui, point)
                    time.sleep(0.5)
                    selected = capture('mask-text-selected')
                    if blue_coverage(selected) - baseline < 0.08:
                        raise AssertionError('Double-click did not visibly highlight the mask text')
                    checks.append('mask-received-double-click:visible-selection')
                if 'scrollHost' in action:
                    # Track one host label and one embedded-page label. Both must
                    # move by the same distance; scrolling inside the OOPIF fails.
                    host = action['hostAnchor']
                    child = action['childAnchor']
                    frame = capture('before-host-scroll')
                    host_before = locate_text(host, frame)
                    child_before = locate_text(child, frame)
                    click_control(gui, host_before)
                    gui.scroll(action['scrollHost'])
                    time.sleep(2)
                    frame = capture('after-host-scroll')
                    host_after = locate_text(host, frame)
                    child_after = locate_text(child, frame)
                    host_delta = host_after[1] - host_before[1]
                    child_delta = child_after[1] - child_before[1]
                    if abs(host_delta) < 10 or host_delta * action['scrollHost'] <= 0:
                        raise AssertionError(f'Host did not scroll as requested: {host_delta}')
                    if abs(host_delta - child_delta) > 8 or abs(child_after[0] - child_before[0]) > 8:
                        raise AssertionError(f'OOPIF did not follow host: host={host_delta}, child={child_delta}')
                    checks.append(f'oopif-follows-host-scroll:host={host_delta:.1f},child={child_delta:.1f}')
                if 'clickAt' in action:
                    x, y = action['clickAt']
                    gui.click(rect[0] + rect[2] * x, rect[1] + rect[3] * y)
                if 'key' in action:
                    gui.press(action['key'])
                if 'move' in action:
                    x, y = action['move']
                    gui.moveTo(rect[0] + rect[2] * x, rect[1] + rect[3] * y, duration=0.3)
                if 'expectText' in action:
                    await_text(action['expectText'])
                    checks.append('visible-text:' + action['expectText'])
                if action.get('expectCursor'):
                    deadline = time.monotonic() + 15
                    observed = None
                    while time.monotonic() < deadline:
                        frame = capture('cursor-check')
                        cx, cy = locate_text('Cursor', frame)
                        scale = frame.width / rect[2]
                        left, top = (cx - rect[0]) * scale, (cy - rect[1]) * scale
                        readout = frame.crop((round(left - 45 * scale), round(top + 5 * scale),
                                              round(left + 150 * scale), round(top + 45 * scale)))
                        value = pytesseract.image_to_string(readout, config='--psm 6 -c tessedit_char_whitelist=0123456789,')
                        pair = re.search(r'(\d+)\s*,\s*(\d+)', value)
                        if pair:
                            observed = tuple(map(int, pair.groups()))
                            pointer = tuple(gui.position())
                            if not cursor_readings or all(abs((observed[i] - cursor_readings[-1][0][i]) -
                                                               (pointer[i] - cursor_readings[-1][1][i])) <= 8 for i in (0, 1)):
                                cursor_readings.append((observed, pointer))
                                break
                        time.sleep(1)
                    else:
                        raise AssertionError(f'Native cursor readout did not follow mouse movement: {observed}')
                    checks.append(f'native-cursor-readout:{observed[0]},{observed[1]}')
                if 'expectCounter' in action:
                    expected = action['expectCounter']
                    if expected == 'reset' and not counter_changed:
                        raise AssertionError('Cannot verify reset before a visible counter increment')
                    deadline = time.monotonic() + 15
                    while time.monotonic() < deadline:
                        frame = capture('counter-' + expected)
                        difference = counter_difference(initial_counter, counter_region(frame))
                        if (expected == 'incremented' and difference > 2) or (expected == 'reset' and difference < 0.5):
                            counter_changed = counter_changed or expected == 'incremented'
                            break
                        time.sleep(0.5)
                    else:
                        raise AssertionError(f'Counter did not visibly {expected}: difference from initial={difference:.2f}')
                    checks.append('visible-counter:' + expected)
                if 'absentText' in action:
                    time.sleep(1)
                    observed = ''.join(text(capture('absence-check')).casefold().split())
                    if ''.join(action['absentText'].casefold().split()) in observed:
                        raise AssertionError(f'Text should be occluded: {action["absentText"]}')
                    checks.append('occluded-text:' + action['absentText'])
                time.sleep(action.get('settle', 1))
                after = capture(f'{index + 2:02d}-interaction')
                if action.get('expectChange'):
                    difference = ImageStat.Stat(ImageChops.difference(before.convert('RGB'), after.convert('RGB')))
                    if max(difference.mean) < 0.1:
                        raise AssertionError('Input did not produce a visible change')
                    checks.append('visible-response-to-input')
                before = after
            if process.poll() is not None:
                raise RuntimeError('App exited during interaction')
            result['ok'] = True
    except Exception as error:
        result['error'] = str(error)
        try:
            gui.screenshot().save(output / 'failure.png')
            shots.append('failure.png')
        except Exception as capture_error:
            result['captureError'] = str(capture_error)
        raise
    finally:
        (output / 'result.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
        if process:
            stop(process)


if __name__ == '__main__':
    inspect_app(json.loads(Path(sys.argv[1]).read_text(encoding='utf-8')))
