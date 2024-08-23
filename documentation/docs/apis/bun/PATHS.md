> Global paths exposed by Electrobun

```
import {PATHS} from "electrobun/bun";

// in a macOS bundle this is where static bundled resources are kept.

// Note: You shouldn't modify or write to the bundle at runtime as it will affect code signing
// integrity.
PATHS.RESOURCES_FOLDER

// Typically you would use the views:// url scheme which maps to
// RESOURCES_FOLDER + '/app/views/'
// But there may be cases in bun where you want to read a file directly.
PATHS.VIEWS_FOLDER

```
