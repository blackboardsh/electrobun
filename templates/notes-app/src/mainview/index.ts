import Electrobun, { Electroview } from "electrobun/view";

type Note = {
	id: string;
	title: string;
	content: string;
	updatedAt: string;
};

type NotesRPC = {
	bun: {
		requests: {
			getNotes: { params: {}; response: Note[] };
			getNote: { params: { id: string }; response: Note | null };
			saveNote: {
				params: { id?: string; title: string; content: string };
				response: { success: boolean; note: Note };
			};
			deleteNote: { params: { id: string }; response: { success: boolean } };
			exportNote: {
				params: { id: string };
				response: { success: boolean; path?: string };
			};
		};
		messages: {};
	};
	webview: {
		requests: {};
		messages: {};
	};
};

const rpc = Electroview.defineRPC<NotesRPC>({
	maxRequestTime: 30000,
	handlers: {
		requests: {},
		messages: {},
	},
});

const electrobun = new Electrobun.Electroview({ rpc });

// DOM elements
const noteList = document.getElementById("note-list") as HTMLDivElement;
const editorEmpty = document.getElementById("editor-empty") as HTMLDivElement;
const editorActive = document.getElementById("editor-active") as HTMLDivElement;
const noteTitle = document.getElementById("note-title") as HTMLInputElement;
const noteContent = document.getElementById("note-content") as HTMLTextAreaElement;
const exportBtn = document.getElementById("export-btn") as HTMLButtonElement;
const deleteBtn = document.getElementById("delete-btn") as HTMLButtonElement;
const newNoteBtn = document.getElementById("new-note") as HTMLButtonElement;

let currentNoteId: string | null = null;
let saveTimeout: ReturnType<typeof setTimeout> | null = null;

// Load notes on start
async function loadNotes() {
	const notes = await electrobun.rpc!.request.getNotes({});
	renderNoteList(notes);
}

function renderNoteList(notes: Note[]) {
	noteList.innerHTML = "";
	for (const note of notes) {
		const item = document.createElement("div");
		item.className = `note-item${note.id === currentNoteId ? " active" : ""}`;
		item.dataset.id = note.id;

		const date = new Date(note.updatedAt);
		const dateStr = date.toLocaleDateString(undefined, {
			month: "short",
			day: "numeric",
		});
		const preview = note.content.slice(0, 60).replace(/\n/g, " ");

		item.innerHTML = `
			<div class="note-item-title">${note.title || "Untitled"}</div>
			<div class="note-item-date">${dateStr}</div>
			<div class="note-item-preview">${preview || "No content"}</div>
		`;

		item.addEventListener("click", () => selectNote(note.id));
		noteList.appendChild(item);
	}
}

async function selectNote(id: string) {
	// Save current note first
	await saveCurrentNote();

	const note = await electrobun.rpc!.request.getNote({ id });
	if (!note) return;

	currentNoteId = note.id;
	noteTitle.value = note.title;
	noteContent.value = note.content;

	editorEmpty.style.display = "none";
	editorActive.style.display = "flex";

	// Update active state in list
	document.querySelectorAll(".note-item").forEach((el) => {
		el.classList.toggle("active", (el as HTMLElement).dataset.id === id);
	});
}

async function saveCurrentNote() {
	if (!currentNoteId) return;
	if (saveTimeout) clearTimeout(saveTimeout);

	await electrobun.rpc!.request.saveNote({
		id: currentNoteId,
		title: noteTitle.value,
		content: noteContent.value,
	});
}

function scheduleSave() {
	if (saveTimeout) clearTimeout(saveTimeout);
	saveTimeout = setTimeout(async () => {
		await saveCurrentNote();
		await loadNotes();
	}, 500);
}

// Auto-save on changes
noteTitle.addEventListener("input", scheduleSave);
noteContent.addEventListener("input", scheduleSave);

// New note
newNoteBtn.addEventListener("click", async () => {
	await saveCurrentNote();
	const result = await electrobun.rpc!.request.saveNote({
		title: "Untitled",
		content: "",
	});
	if (result.success) {
		currentNoteId = result.note.id;
		noteTitle.value = result.note.title;
		noteContent.value = "";
		editorEmpty.style.display = "none";
		editorActive.style.display = "flex";
		await loadNotes();
		noteTitle.focus();
		noteTitle.select();
	}
});

// Export
exportBtn.addEventListener("click", async () => {
	if (!currentNoteId) return;
	await saveCurrentNote();
	await electrobun.rpc!.request.exportNote({ id: currentNoteId });
});

// Delete
deleteBtn.addEventListener("click", async () => {
	if (!currentNoteId) return;
	await electrobun.rpc!.request.deleteNote({ id: currentNoteId });
	currentNoteId = null;
	editorEmpty.style.display = "flex";
	editorActive.style.display = "none";
	await loadNotes();
});

// Initial load
loadNotes();
