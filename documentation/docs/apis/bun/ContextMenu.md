> Show a context menu

Typically you'd wire up a rightclick event with preventDefault in the browser context, rpc to bun, then create a native context menu from the bun context. But you can also create and show a context menu entirely from bun which will show at the mouse cursor's position globally positioned on screen even outside of your application window. Even if you have no windows open and another app is focused.

```
import {ContextMenu} from "electrobun/bun";

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
