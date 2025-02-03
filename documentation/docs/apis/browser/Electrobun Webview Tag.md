## Introduction

Electrobun's custom webview tag implementation behaves similarly to an enhanced iframe, but with key differences in capabilities and isolation. It serves as a positional anchor within the DOM, communicating with a Zig backend to manage a distinct, isolated BrowserView. This separation ensures full content isolation from the host webview, enhancing both security and performance.

## Basic Usage

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>webview tag test</title>
    <script src="views://webviewtag/index.js"></script>
  </head>

  <body>
    <electrobun-webview src="https://electrobun.dev"></electrobun-webview>
  </body>
</html>
```

## Compatability

The Electrobun webview tag integrates seamlessly with any reactive JavaScript framework, such as React or SolidJS, allowing for dynamic interactions and updates without disrupting the isolation of the webview's contents.

The way the implementation currently works, the html element is just a positional anchor that reports its position and relays events to zig which manages a completely separate BrowserView and overlays it at the same coordinates within the window.

## How is this difffernt to Electron's webview tag

### Chrome plans to deprecate their webviewtag

Electron's webview tag is based on a Chrome feature/api designed for Chrome apps which has been deprecated since 2020. You can read about that on [Electron's Github](https://github.com/electron/electron/issues/34356) and in [Chrome's developer docs](https://developer.chrome.com/docs/apps/reference/webviewTag). The warning declares it "remains supported for Enterprise and Education customers on ChromeOS until at least Jan 2025" which is fast approaching.

It's unknown what Electron will do when and if Chrome actually removes webview tag support from Chrome.

Unlike Electron's reliance on Chrome's now-deprecated webview tag, Electrobun introduces its own robust implementation that does not depend on Chrome's lifecycle. This independence ensures longevity and stability for applications using Electrobun's framework, even as Chrome phases out its support.

### Electrobun's webview tag is a separate layer

Because Electrobun's webview tag implementation uses a div anchor and then positions a separate isolated BrowserView above the parent BrowserView there are some interesting edge cases where you may want to click on the parent document or do things within the parent DOM, so Electrobun provides various special methods for handling those situations. For example ways to mirror a screenshot of the webview tag's contents to the host's anchor and hide it or stream an image of the contents.

## Properties and Attributes

### src

**Type**: `string`  
**Description**: URL of the web page to load in the webview.

### html

**Type**: `string`  
**Description**: HTML content to be directly loaded into the webview, useful for dynamic content generation.

### preload

**Type**: `string`  
**Description**: Path to a script that should be preloaded before any other scripts run in the webview.

### partition

**Type**: `string`  
**Description**: Sets a partition to provide separate storage for different sessions, useful in multi-user applications.

### transparent

**Type**: `boolean`  
**Description**: When set to true, makes the webview transparent, allowing underlying elements to be visible.

### passthroughEnabled

**Type**: `boolean`  
**Description**: Enables or disables mouse and touch events to pass through to underlying elements.

### hidden

**Type**: `boolean`  
**Description**: Controls the visibility of the webview.

### delegateMode

**Type**: `boolean`  
**Description**: Activates a mode where input is delegated to the webview even when it is visually mirrored to another element.

### hiddenMirrorMode

**Type**: `boolean`  
**Description**: Enables a mode where the webview is hidden and mirrored, allowing smooth interactions during transitions or animations.

### wasZeroRect

**Type**: `boolean`  
**Description**: Indicates if the webview had zero dimensions at any point, used internally to optimize rendering and updates.

### webviewId

**Type**: `number`
**Description**: A unique identifier for the webview instance, automatically managed by the system.

### id

**Type**: `string`  
**Description**: The DOM ID for the webview element, automatically set to ensure uniqueness.

## Methods

### callAsyncJavaScript

**Parameters**: `{ script: string }`  
**Returns**: `Promise`
**Description**: Executes JavaScript code asynchronously within the webview and returns a promise with the result.

### canGoBack

**Returns**: `Promise<boolean>`
**Description**: Determines if the webview can navigate backward.

### canGoForward

**Returns**: `Promise<boolean>`
**Description**: Determines if the webview can navigate forward.

### on

**Parameters**: `event: WebviewEventTypes, listener: () => {}`  
**Description**: Attach event listeners for webview-specific events such as navigation and loading.

### off

**Parameters**: `event: WebviewEventTypes, listener: () => {}`  
**Description**: Detach event listeners for webview-specific events.

### syncDimensions

**Parameters**: `force: boolean = false`  
**Description**: Synchronizes the dimensions and position of the webview with its anchor element in the DOM, optionally forcing an update.

### goBack

**Description**: Navigates the webview back to the previous page.

### goForward

**Description**: Navigates the webview forward to the next page.

### reload

**Description**: Reloads the current content in the webview.

### loadURL

**Parameters**: `url: string`  
**Description**: Loads a given URL into the webview, similar to setting the `src` attribute.

### syncScreenshot

**Parameters**: `callback?: () => void`  
**Description**: Captures and synchronizes a screenshot of the webview's contents, useful for visual mirroring.

### clearScreenImage

**Description**: Clears any images set as the webview anchor's background, typically used in conjunction with transparency and mirroring modes.

### tryClearScreenImage

**Description**: Attempts to clear the background image of the webview anchor if conditions are met.

### toggleTransparent

**Parameters**: `transparent?: boolean, bypassState?: boolean`  
**Description**: Toggles the transparency state of the webview.

### togglePassthrough

**Parameters**: `enablePassthrough?: boolean, bypassState?: boolean`  
**Description**: Toggles the ability for mouse and touch events to pass through the webview.

### toggleHidden

**Parameters**: `hidden?: boolean, bypassState?: boolean`  
**Description**: Toggles the visibility of the webview.

### toggleDelegateMode

**Parameters**: `delegateMode?: boolean`  
**Description**: Toggles the delegate mode for input events within the webview.

### toggleHiddenMirrorMode

**Parameters**: `force: boolean`  
**Description**: Toggles the hidden mirror mode, optimizing interaction during transitions or animations.
