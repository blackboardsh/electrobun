import { Tray, Utils } from "electrobun/bun";

// Create a system tray icon
const tray = new Tray({
	title: "Tray App",
});

// Set up the tray context menu
tray.setMenu([
	{ type: "normal", label: "Electrobun Docs", action: "docs" },
	{ type: "normal", label: "Colab", action: "colab" },
	{ type: "normal", label: "Electrobun Github", action: "github" },
	{ type: "divider" },
	{ type: "normal", label: "Quit", action: "quit" },
]);

// Handle menu item clicks
tray.on("tray-clicked", (event: any) => {
	const action = event.data?.action;

	switch (action) {
		case "docs":
			Utils.openExternal("https://electrobun.dev");
			break;
		case "colab":
			Utils.openExternal("https://blackboard.sh/colab/");
			break;
		case "github":
			Utils.openExternal("https://github.com/blackboardsh/electrobun");
			break;
		case "quit":
			tray.remove();
			process.exit(0);
			break;
	}
});

console.log("Tray app started! Look for it in your menu bar.");
