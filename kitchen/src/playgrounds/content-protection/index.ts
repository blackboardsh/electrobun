import { Electroview } from "electrobun/view";

// Define RPC schema for communication with Bun
const rpc = Electroview.defineRPC<any>({
	maxRequestTime: 600000,
	handlers: {
		requests: {},
		messages: {},
	},
});

const electroview = new Electroview({ rpc });

document.addEventListener("DOMContentLoaded", () => {
	const toggleBtn = document.getElementById("toggleBtn");
	const statusBox = document.getElementById("statusBox");
	let isProtected = true;

	toggleBtn?.addEventListener("click", () => {
		isProtected = !isProtected;

		// Update UI
		if (statusBox) {
			statusBox.innerText = `PROTECTION IS ${isProtected ? "ON" : "OFF"}`;
			statusBox.className = `status-box ${isProtected ? "status-on" : "status-off"}`;
		}

		// Send message to Bun to update native window property
		(electroview.rpc as any).send.toggleContentProtection({
			enabled: isProtected,
		});
	});
});
