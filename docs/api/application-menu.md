---
title: "Application Menu"
---

Create and control an application menu. In MacOS this is the menu in the top-left with File, Edit, and so on.

```ts
ApplicationMenu.setApplicationMenu([
  {
    submenu: [{ label: "Quit", role: "quit" }],
  },
  {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      {
label: "Custom Menu Item  🚀",
action: "custom-action-1",
tooltip: "I'm a tooltip",
      },
      {
label: "Custom menu disabled",
enabled: false,
action: "custom-action-2",
      },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "pasteAndMatchStyle" },
      { role: "delete" },
      { role: "selectAll" },
    ],
  },
]);

Electrobun.events.on("application-menu-clicked", (e) => {
  console.log("application menu clicked", e.data.action); // custom-actino
});

```

### setApplicationMenu
This function takes an array of menu items. Here are some example menu items:

### Menu dividers


```ts
// menu dividers
{type: "divider"}
// or
{type: "separator"}

```

### Default Roles
Menu items can specify a role instead of an action. Use menu item roles to access built-in OS functionality and enable their corresponding keyboard shortcuts.If you want to enable keyboard shortcuts like `` cmd+q `` to quit your application, `` cmd+c `` and `` cmd+v `` for copy and paste then you need to specify menu items with the corresponding roles.

```ts
// example Edit menu
 {
    label: "Edit",
    submenu: [
      // Corresponding keyboard shotcuts will automatically
      // be bound when a valid role is set.
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "pasteAndMatchStyle" },
      { role: "delete" },
      { role: "selectAll" },
    ],
  },

```

List of supported roles

```

  quit: "Quit",
  hide: "Hide",
  hideOthers: "Hide Others",
  showAll: "Show All",
  undo: "Undo",
  redo: "Redo",
  cut: "Cut",
  copy: "Copy",
  paste: "Paste",
  pasteAndMatchStyle: "Paste And Match Style",
  delete: "Delete",
  selectAll: "Select All",
  startSpeaking: "Start Speaking",
  stopSpeaking: "Stop Speaking",
  enterFullScreen: "Enter FullScreen",
  exitFullScreen: "Exit FullScreen",
  toggleFullScreen: "Toggle Full Screen",
  minimize: "Minimize",
  zoom: "Zoom",
  bringAllToFront: "Bring All To Front",
  close: "Close",
  cycleThroughWindows: "Cycle Through Windows",
  showHelp: "Show Help",

```

### Custom Menu Items
Instead of a role you can specify and action, you can then listen for that action in the 'application-menu-clicked' event.

```ts
// basic menu item
{label: "I am a menu item", action: 'some-action'}

```

## Optionaly properties

### enabled
Set to false to show the menu item as disabled

### checked
Set to true to show a checkbox next to the menu item.

### hidden
Set to true to hide

### tooltip
Will show this tooltip when hovering over the menu item

### submenu
The top-level menu corresponds to the menu items you see when the app is focused, eg: File, Edit, View, etc. You can add actions to those if you want and treat them like buttons, but you can also add nested submenus.

### accelerator
Set a custom keyboard shortcut for the menu item. This is useful when you want a custom action to have a keyboard shortcut that isn't covered by the built-in roles.

```ts
// Custom menu item with keyboard shortcut
{
  label: "Save Project",
  action: "save-project",
  accelerator: "s"  // Will show as Cmd+S on macOS, Ctrl+S on Windows
}

```

The accelerator string specifies the key to bind. The default modifier is Command on macOS and Ctrl on Windows.

#### Platform Support

- **macOS:** Full support for custom accelerators. The default modifier is Command.

- **Windows:** Supports simple single-character accelerators (e.g., "s", "n", "o"). Complex combinations may not work as expected.

- **Linux:** Application menus are not currently supported on Linux.
**Note:** If you use a role (like "copy" or "paste"), the OS automatically assigns the standard keyboard shortcut. Only use `` accelerator `` for custom actions.