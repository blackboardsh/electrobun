## Linux System Tray Support

System tray functionality on Linux requires a compatible desktop environment or additional packages. Many modern Linux distributions (especially those using GNOME 3.26+) don't display system trays by default.

### Installation Instructions by Desktop Environment

You probably need to tell users to install whatever system tray thing works on their linux distro or whatever.

**For Unity:**

```bash
# Install indicator support
sudo apt install indicator-application

```

**For KDE Plasma, XFCE, MATE, Cinnamon:**

- System tray support works out of the box, no additional installation needed

### Alternative Installation Method

You can also install the GNOME extension through your web browser:

1. Visit https://extensions.gnome.org/extension/615/appindicator-support/
2. Install the browser extension if prompted
3. Click the toggle to enable the extension

### Verifying Installation

After installation and restart, system tray icons should appear in your top panel (usually top-right corner). If the tray still doesn't appear, your application will continue to function normally without tray support.

### Note for Application Developers

When distributing Electrobun applications that use system tray:

- Document the system tray requirements for GNOME users
- Consider providing alternative UI access to tray functionality
- The tray implementation gracefully handles environments where system tray is unavailable

### Application menus

The standard file, edit, etc. menus are super jank and would complicated the complex OOPIF compositing we do on gtk windows and x11 so on linux they're not wired up. You can get the same functionality by just using html in your webview to make a menu like interface and rpc to bun.

### Context menus

Likewise the showContextMenu functionality that works on mac to show an arbitrary context menu wherever the mouse is (regardless of what it's over or what app is focused) is just not a ux linux supports well so that's also a noop on linux
