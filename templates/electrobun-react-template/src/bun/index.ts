import { BrowserWindow } from "electrobun/main";
import { getMainViewUrl } from "../shared/helpers/hmr";
import { rpcSchema } from "../shared/rpc/schemas";

const url = await getMainViewUrl();

// Create the browser window
const app = new BrowserWindow({
    title: "Your App",
    url,
    frame: { width: 800, height: 800 },
    rpc: rpcSchema,
});

// Center the window on the screen
app.center();

console.log("Your app started!");
