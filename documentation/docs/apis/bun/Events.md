> Event system in the main bun process

## Event Propagation

### Global Events

Most events can be listened to directly on the thing firing them or globally.

Global Event handlers fire first. Then handlers are fired in the sequence that they were registered in.

```
// listen to global event
Electrobun.events.on("will-navigate", (e) => {
    // handle
});

// listen to event on object
win.webview.on('will-navigate', (e) => {
    // handle
})
```

### Event.response

You can set a response on some events. Typically these are events initiated from zig which freeze the zig process while waiting for a reply from bun. An example of this is the BrowserView `will-navigate` where objc requires a synchronous response. By freezing the zig process and waiting for bun we allow bun to remain async while the events propagate.

```
Electrobun.events.on("will-navigate", (e) => {
  console.log(
    "example global will-navigate handler",
    e.data.url,
    e.data.webviewId
  );
  e.response = { allow: true };
});
```

As the event propagates through different handlers you can both read and write from the e.response value.

### Event.responseWasSet

A property that indicates the response has been set to something which can be useful when an event propagates through multiple handlers instead of trying to infer from the response value whether it was set or not.

### Event.clearResponse

If a previous handler has set the e.response to something and you want to clear it, you can simply call `e.clearResponse()`

### Event.data

Each event will set different event data
