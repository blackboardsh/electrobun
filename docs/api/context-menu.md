---
title: "Context Menu"
---

Show a context menuTypically you'd wire up a rightclick event with preventDefault in the browser context, rpc to bun, then create a native context menu from the bun context. But you can also create and show a context menu entirely from bun which will show at the mouse cursor's position globally positioned on screen even outside of your application window. Even if you have no windows open and another app is focused.

```ts
// Show a context menu wherever the mouse cursor is on screen
// after 5 seconds.
setTimeout(() => {
  ContextMenu.showContextMenu([
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
    {
      label: "Custom menu disabled",
      enabled: false,
      action: "custom-action-2",
      // todo: support a data property on all menus (app, tray, context)
      data: {
some: "data",
that: "is serialized",
nested: { thing: 23 },
      },
    },
    { type: "separator" },
    { role: "cut" },
    { role: "copy" },
    { role: "paste" },
    { role: "pasteAndMatchStyle" },
    { role: "delete" },
    { role: "selectAll" },
  ]);
}, 5000);

Electrobun.events.on("context-menu-clicked", (e) => {
  console.log("context event", e.data.action);
});

```

## Menu Item Properties

### accelerator
You can set a custom keyboard shortcut hint for context menu items using the `` accelerator `` property. This displays the shortcut next to the menu item label.

```ts
ContextMenu.showContextMenu([
  {
    label: "Save",
    action: "save",
    accelerator: "s"  // Shows Cmd+S on macOS
  },
  {
    label: "New Tab",
    action: "new-tab",
    accelerator: "t"
  },
  { type: "separator" },
  { role: "copy" },
  { role: "paste" },
]);

```

#### Platform Support

- **macOS:** Full support. Accelerators are displayed next to menu items with Command as the default modifier.

- **Windows:** Supports simple single-character accelerators.

- **Linux:** Context menus are not currently supported on Linux.

### Other Properties

- **label:** The text displayed for the menu item

- **action:** A string identifier emitted when the item is clicked

- **role:** Use a built-in role instead of a custom action (e.g., "copy", "paste", "cut")

- **enabled:** Set to false to show the item as disabled

- **checked:** Set to true to show a checkbox

- **hidden:** Set to true to hide the item

- **tooltip:** Tooltip text shown on hover

- **data:** Arbitrary data passed through with the click event

- **submenu:** Nested array of menu items for submenus
