> Create and manage system tray icon and menu.

```
import {Tray} from "electrobun/bun";

const tray = new Tray({
  title: "Example Tray Item (click to create menu)",
  // This can be a views url or an absolute file path
  image: `views://assets/electrobun-logo-32-template.png`,
  template: true,
  width: 32,
  height: 32,
});

// map action names to clicked state
// Note: This is just used for this example
const menuState = {
  "item-1": false,
  "sub-item-1": false,
  "sub-item-2": true,
};

const updateTrayMenu = () => {
  tray.setMenu([
    {
      type: "normal",
      label: `Toggle me`,
      action: "item-1",
      checked: menuState["item-1"],
      tooltip: `I'm a tooltip`,
      submenu: [
        {
          type: "normal",
          label: "Click me to toggle sub-item 2",
          tooltip: "i will also unhide sub-item-3",
          action: "sub-item-1",
        },
        {
          type: "divider",
        },
        {
          type: "normal",
          label: "Toggle sub-item-3's visibility",
          action: "sub-item-2",
          enabled: menuState["sub-item-1"],
        },
        {
          type: "normal",
          label: "I was hidden",
          action: "sub-item-3",
          hidden: menuState["sub-item-2"],
        },
      ],
    },
  ]);
};

// TODO: events should be typed
tray.on("tray-clicked", (e) => {
  const { id, action } = e.data as { id: number; action: string };

  if (action === "") {
    // main menu was clicked before we create a system tray menu for it.
    updateTrayMenu();
    tray.setTitle("Example Tray Item (click to open menu)");
  } else {
    // once there's a menu, we can toggle the state of the menu items
    menuState[action] = !menuState[action];
    updateTrayMenu();
  }
  // respond to left and right clicks on the tray icon/name
  console.log("event listener for tray clicked", e.data.action);
});

```

## Constructor Options

### title

This is the text that will appear in your system tray

### image

This is an optional url to an image to load. You can use the `views://` schema to access local bundled images.

### template

You can use a full-color image like a png but that image will just be shown as is. On MacOS you can create a template image and set the `template` property to true. A template image uses opacity to define a black and white image that adapts to your systems light/dark mode.

### width and height

Set the dimensions of the image used in the system tray

## Methods

### setMenu

Call setMenu whenever you want to show the menu. Typically you would listen for the `tray-clicked` event, then show the menu and listen for the `tray-item-clicked`. Your app could also listen for keyboard shortcuts or show the system tray menu in response to something else.

A common pattern is to create a function that dynamically generates the menu from some kind of state to implement things like checkbox toggles.

### Menu Items

See [Application Menu](/docs/apis/bun/ApplicationMenu) for more info on available properties for menu items.

## Events

### tray-clicked

This is fired when the system tray item itself is clicked

### tray-item-clicked

This is fired when a system tray menu item or submenu item is clicked.
