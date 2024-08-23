> Configure an html element to function as a draggable region allowing you to move the native application window by clicking and dragging on the element.

When building desktop apps with Electrobun a common pattern is to create a frameless window, sometimes with the traffic light (close, minimize, maximize) buttons overlayed with the html content. You would then use html and css to create a top-bar and set that top-bar to be a draggable region allowing you full control over the style of the window.

You can set any html element to be a draggable region.

### Step 1: Instantiate the Electroview class

```typescript title="/src/mainview/index.ts"
import { Electroview } from "electrobun/view";

const electrobun = new Electroview();
```

### Step 2: Add the draggable region css class

Insantiating `Electroview()` will configure any element with the `electrobun-webkit-app-region-drag` css class as a draggable area.

```html title="/src/mainview/index.html"
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>My Electrobun app</title>
    <script src="views://mainview/index.js"></script>
    <link rel="stylesheet" href="views://mainview/index.css" />
  </head>
  <body>
    <div class="electrobun-webkit-app-region-drag">
      click here and drag to move this window
    </div>
    <h1>hi World</h1>
  </body>
</html>
```
