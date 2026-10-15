"""Fail quickly if the hosted desktop cannot capture pixels or receive input."""
from pathlib import Path
import sys
import subprocess
import time
import tkinter as tk
import pyautogui as gui
from PIL import ImageStat

output = Path(sys.argv[1])
output.mkdir(parents=True, exist_ok=True)
root = tk.Tk()
root.title('Electrobun smoke desktop preflight')
root.geometry('400x240+100+100')
root.configure(background='#13c957')
root.attributes('-topmost', True)
clicked = []
button = tk.Button(root, text='Verify input', command=lambda: clicked.append(True))
button.pack(padx=80, pady=80)
try:
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        root.update()
        time.sleep(0.05)
    # Fresh Xvfb sessions can leave the pointer at (0, 0), which is a
    # PyAutoGUI emergency-stop corner. Initialize it before the first action;
    # keep the failsafe enabled throughout the actual desktop tests.
    if sys.platform == 'linux' and tuple(gui.position()) in gui.FAILSAFE_POINTS:
        subprocess.run(['xdotool', 'mousemove', '--sync',
                        str(button.winfo_rootx() + button.winfo_width() // 2),
                        str(button.winfo_rooty() + button.winfo_height() // 2)], check=True)
    gui.click(button.winfo_rootx() + button.winfo_width() / 2,
              button.winfo_rooty() + button.winfo_height() / 2)
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
    assert max(abs(actual - expected) for actual, expected in zip(rgb, (19, 201, 87))) < 8, f'Desktop capture does not contain the visible probe: {rgb}'
    print('Desktop capture and native mouse input passed')
finally:
    root.destroy()
