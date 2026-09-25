import { Updater } from "electrobun/main";
import { VITE_DEV_SERVER_URL } from "../constants/vite";

export async function getMainViewUrl(): Promise<string> {
    const channel = await Updater.localInfo.channel();

    if (channel === "dev") {
        try {
            await fetch(VITE_DEV_SERVER_URL, { method: "HEAD" });
            console.log(
                `HMR enabled: using Vite dev server at ${VITE_DEV_SERVER_URL}`,
            );
            return VITE_DEV_SERVER_URL;
        } catch {
            console.log(
                "Vite dev server not running; using bundled views:// assets",
            );
        }
    }

    return "views://mainview/index.html";
}
