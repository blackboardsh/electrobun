import { Tray } from "electrobun/bun";

// Create a system tray icon
const tray = new Tray({
	title: "Tray App",
});

// Track a simple counter to demonstrate dynamic tray updates
let count = 0;

// Set up the tray context menu
function updateMenu() {
	tray.setMenu([
		{ type: "normal", label: `Count: ${count}`, action: "show-count", enabled: false },
		{ type: "divider" },
		{ type: "normal", label: "Increment", action: "increment" },
		{ type: "normal", label: "Decrement", action: "decrement" },
		{ type: "normal", label: "Reset", action: "reset" },
		{ type: "divider" },
		{
			type: "normal",
			label: "More Options",
			submenu: [
				{ type: "normal", label: "Say Hello", action: "hello" },
				{ type: "normal", label: "Show Time", action: "time" },
			],
		},
		{ type: "divider" },
		{ type: "normal", label: "Quit", action: "quit" },
	]);
}

updateMenu();

// Handle menu item clicks
tray.on("tray-clicked", (event: any) => {
	const action = event.data?.action;

	switch (action) {
		case "increment":
			count++;
			tray.setTitle(`Tray App (${count})`);
			updateMenu();
			break;
		case "decrement":
			count--;
			tray.setTitle(`Tray App (${count})`);
			updateMenu();
			break;
		case "reset":
			count = 0;
			tray.setTitle("Tray App");
			updateMenu();
			break;
		case "hello":
			console.log("Hello from the tray app!");
			break;
		case "time":
			console.log(`Current time: ${new Date().toLocaleTimeString()}`);
			break;
		case "quit":
			tray.remove();
			process.exit(0);
			break;
	}
});

console.log("Tray app started! Look for it in your menu bar.");
