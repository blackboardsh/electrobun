import Electrobun, { Electroview } from "electrobun/view";

type MainWindowRPC = {
	bun: {
		requests: {
			openChildWindow: {
				params: { title?: string };
				response: { id: number };
			};
			closeChildWindow: {
				params: { id: number };
				response: { success: boolean };
			};
			getChildWindows: {
				params: {};
				response: Array<{ id: number; title: string }>;
			};
			sendToChild: {
				params: { id: number; message: string };
				response: { success: boolean };
			};
		};
		messages: {};
	};
	webview: {
		requests: {};
		messages: {
			childWindowOpened: { id: number; title: string };
			childWindowClosed: { id: number };
			receiveMessage: { from: string; message: string };
		};
	};
};

const rpc = Electroview.defineRPC<MainWindowRPC>({
	maxRequestTime: 5000,
	handlers: {
		requests: {},
		messages: {
			childWindowOpened: ({ id, title }) => {
				addChildToList(id, title);
				addTargetOption(id, title);
			},
			childWindowClosed: ({ id }) => {
				removeChildFromList(id);
				removeTargetOption(id);
			},
			receiveMessage: ({ from, message }) => {
				addMessage(from, message);
			},
		},
	},
});

const electrobun = new Electrobun.Electroview({ rpc });

// DOM elements
const openBtn = document.getElementById("open-child") as HTMLButtonElement;
const childList = document.getElementById("child-list") as HTMLDivElement;
const targetSelect = document.getElementById("target-window") as HTMLSelectElement;
const messageInput = document.getElementById("message-input") as HTMLInputElement;
const sendBtn = document.getElementById("send-btn") as HTMLButtonElement;
const messagesDiv = document.getElementById("messages") as HTMLDivElement;

// Show empty state
messagesDiv.innerHTML = '<div class="empty-state">No messages yet</div>';

openBtn.addEventListener("click", async () => {
	await electrobun.rpc!.request.openChildWindow({});
});

sendBtn.addEventListener("click", async () => {
	const targetId = parseInt(targetSelect.value);
	const message = messageInput.value.trim();
	if (!targetId || !message) return;

	await electrobun.rpc!.request.sendToChild({ id: targetId, message });
	addMessage("You → Child " + targetId, message);
	messageInput.value = "";
});

messageInput.addEventListener("keydown", (e) => {
	if (e.key === "Enter") sendBtn.click();
});

function addChildToList(id: number, title: string) {
	const item = document.createElement("div");
	item.className = "child-item";
	item.id = `child-${id}`;
	item.innerHTML = `
		<span>${title}</span>
		<button class="danger" onclick="closeChild(${id})">Close</button>
	`;
	childList.appendChild(item);
}

function removeChildFromList(id: number) {
	document.getElementById(`child-${id}`)?.remove();
}

function addTargetOption(id: number, title: string) {
	const option = document.createElement("option");
	option.value = String(id);
	option.textContent = title;
	option.id = `option-${id}`;
	targetSelect.appendChild(option);
}

function removeTargetOption(id: number) {
	document.getElementById(`option-${id}`)?.remove();
}

function addMessage(from: string, message: string) {
	const emptyState = messagesDiv.querySelector(".empty-state");
	if (emptyState) emptyState.remove();

	const entry = document.createElement("div");
	entry.className = "message-entry";
	entry.innerHTML = `<span class="from">${from}:</span> ${message}`;
	messagesDiv.appendChild(entry);
	messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// Global function for close buttons
(window as any).closeChild = async (id: number) => {
	await electrobun.rpc!.request.closeChildWindow({ id });
};
