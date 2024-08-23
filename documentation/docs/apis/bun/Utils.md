> Various utilities for Electrobun apps.

```
import {Utils} from "electrobun/bun";

```

## moveToTrash

Move a file or folder on your system to the Trash (recycle bin).

:::warning
On MacOS when you move something to trash from the finder you can open the trash can and see a "restore" button that will put the files/folders back where they were deleted from

When using moveToTrash in Electrobun it moves it to the trash can but does not enable the "restore" button. To restore you will need to manually drag the files and folders back to their originating folder
:::

```
Utils.moveToTrash(absolutePath)
```

## showItemInFolder

Open the finder to the specified path

```
Utils.showItemInFolder(absolutePath)
```

## openFileDialog

Open a file dialogue to let the user specify a file or folder and return the path to your app. Typically you would have an event handler in the browser context like clicking an "open" button, this would trigger an rpc call to bun, which would call `openFileDialog()` and then optionally pass the response back to the browser context via rpc after the user has made their selection

```
// To simplify this example we'll just show a dialogue after a 2 second timeout

setTimeout(async () => {

    const chosenPaths = await Utils.openFileDialog({
        startingFolder: join(homedir(), "Desktop"),
        allowedFileTypes: "*",
        // allowedFileTypes: "png,jpg",
        canChooseFiles: true,
        canChooseDirectory: false,
        allowsMultipleSelection: true,
    });

    console.log("chosen paths", chosenPaths);
 }, 2000);

```
