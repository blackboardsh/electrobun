`Electrobun.events` is a custom event emitter in the [Bun api](/docs/apis/bun/Events).

Some events happen entirely within bun process, some happen in a BrowserView and make their way through zig into bun, and others originate in the native code layer (objc on MacOS) through zig into bun and then back to objc. Let's look at how the 'will-navigate' event works.

1. Objc event is fired on a BrowserView and handled by zig
1. zig sends json rpc request to decide navigation over the main bun named pipe with a url and a webviewid
1. zig pauses the main thread simulating a promise-like behaviour while listening on a separate named pipe listener thread
1. bun parses the json rpc and sees it's a 'will navigate' request
1. bun creates a new Electrobun.events.webview.willNavigate event with the data (url and webviewid).
1. bun then emits the event globally `('will-navigate')` that could be listened to with `Electrobun.events.on('will-navigate', handlerFn)`
1. bun then passes the same event to a specific event `('will-navigate-<webviewId>'` eg: `will-navigate-1` for the webview with id 1).
1. you could also listen to this globally via `Electrobun.events.on('will-navigate-1', handlerFn)` if you wanted to. Since ids are incremented deterministically this allows for some interesting patterns like handling navigation for the first window created.
1. you can also listen on the webview with `myWebview.on('will-navigate', handlerFn)`. Webview extends a "event emitter class' that essentially provides `on`, `off`, `appendEventListener`, etc. but instead of being an event listener it modifies the event name to include its id, and subscribes the handler to the main event emitter. So it basically does `Electrobun.events.on('will-navigate-1')` for you without you having to think about the webview's id and providing other lifecycle handling for you.
1. the event object has a `response` getter/setter and a `clearResponse` method that allows any handler to respond with a value as well as a `responseWasSet` flag. so in any handler you can both check if another handler set a response, and if you want override or modify the response.
1. the response is then serialized as an rpc response and sent back to zig which is listening on another thread, zig unfreezes the main thread returning the value to objc.

:::note
Global events are always called before specific events.
:::
