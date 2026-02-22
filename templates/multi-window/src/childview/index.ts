import Electrobun, { Electroview } from "electrobun/view";

type ChildWindowRPC = {
	bun: {
		requests: {
			sendToMain: {
				params: { message: string };
				response: { success: boolean };
			};
		};
		messages: {};
	};
	webview: {
		requests: {};
		messages: {
			receiveMessage: { from: string; message: string };
			setWindowInfo: { id: number; title: string };
		};
	};
};

const rpc = Electroview.defineRPC<ChildWindowRPC>({
	maxRequestTime: 5000,
	handlers: {
		requests: {},
		messages: {
			receiveMessage: ({ from, message }) => {
				addMessage(from, message);
			},
			setWindowInfo: ({ id, title }) => {
				const titleEl = document.getElementById("window-title");
				if (titleEl) titleEl.textContent = `${title} (#${id})`;
			},
		},
	},
});

const electrobun = new Electrobun.Electroview({ rpc });

const messageInput = document.getElementById("message-input") as HTMLInputElement;
const sendBtn = document.getElementById("send-main") as HTMLButtonElement;
const messagesDiv = document.getElementById("messages") as HTMLDivElement;

sendBtn.addEventListener("click", async () => {
	const message = messageInput.value.trim();
	if (!message) return;

	await electrobun.rpc!.request.sendToMain({ message });
	addMessage("You", message);
	messageInput.value = "";
});

messageInput.addEventListener("keydown", (e) => {
	if (e.key === "Enter") sendBtn.click();
});

function addMessage(from: string, message: string) {
	const emptyState = messagesDiv.querySelector(".empty-state");
	if (emptyState) emptyState.remove();

	const entry = document.createElement("div");
	entry.className = "message-entry";
	entry.innerHTML = `<span class="from">${from}:</span> ${message}`;
	messagesDiv.appendChild(entry);
	messagesDiv.scrollTop = messagesDiv.scrollHeight;
}
