import { BrowserView, BrowserWindow, Utils, type RPCSchema, paths } from "electrobun/bun";
import { join } from "path";
import { mkdirSync, existsSync, readdirSync, unlinkSync } from "fs";

// Store notes in app data directory
const notesDir = join(paths.userData, "notes");
if (!existsSync(notesDir)) {
	mkdirSync(notesDir, { recursive: true });
}

type Note = {
	id: string;
	title: string;
	content: string;
	updatedAt: string;
};

type NotesRPC = {
	bun: RPCSchema<{
		requests: {
			getNotes: {
				params: {};
				response: Note[];
			};
			getNote: {
				params: { id: string };
				response: Note | null;
			};
			saveNote: {
				params: { id?: string; title: string; content: string };
				response: { success: boolean; note: Note };
			};
			deleteNote: {
				params: { id: string };
				response: { success: boolean };
			};
			exportNote: {
				params: { id: string };
				response: { success: boolean; path?: string };
			};
		};
		messages: {};
	}>;
	webview: RPCSchema<{
		requests: {};
		messages: {};
	}>;
};

function generateId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function getNotePath(id: string): string {
	return join(notesDir, `${id}.json`);
}

function loadNote(id: string): Note | null {
	const path = getNotePath(id);
	if (!existsSync(path)) return null;
	try {
		const data = Bun.file(path);
		// Use synchronous read
		const text = require("fs").readFileSync(path, "utf-8");
		return JSON.parse(text) as Note;
	} catch {
		return null;
	}
}

function loadAllNotes(): Note[] {
	const files = readdirSync(notesDir).filter((f) => f.endsWith(".json"));
	const notes: Note[] = [];
	for (const file of files) {
		const id = file.replace(".json", "");
		const note = loadNote(id);
		if (note) notes.push(note);
	}
	return notes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

const notesRPC = BrowserView.defineRPC<NotesRPC>({
	maxRequestTime: 10000,
	handlers: {
		requests: {
			getNotes: () => {
				return loadAllNotes();
			},
			getNote: ({ id }) => {
				return loadNote(id);
			},
			saveNote: async ({ id, title, content }) => {
				const noteId = id || generateId();
				const note: Note = {
					id: noteId,
					title: title || "Untitled",
					content,
					updatedAt: new Date().toISOString(),
				};
				await Bun.write(getNotePath(noteId), JSON.stringify(note, null, 2));
				return { success: true, note };
			},
			deleteNote: ({ id }) => {
				const path = getNotePath(id);
				if (existsSync(path)) {
					unlinkSync(path);
					return { success: true };
				}
				return { success: false };
			},
			exportNote: async ({ id }) => {
				const note = loadNote(id);
				if (!note) return { success: false };

				const chosenPaths = await Utils.openFileDialog({
					startingFolder: Bun.env["HOME"] || "/",
					canChooseFiles: false,
					canChooseDirectory: true,
					allowsMultipleSelection: false,
				});

				if (chosenPaths[0] && chosenPaths[0] !== "") {
					const exportPath = join(chosenPaths[0], `${note.title}.txt`);
					await Bun.write(exportPath, note.content);
					return { success: true, path: exportPath };
				}
				return { success: false };
			},
		},
		messages: {},
	},
});

const mainWindow = new BrowserWindow({
	title: "Notes",
	url: "views://mainview/index.html",
	rpc: notesRPC,
	frame: {
		width: 900,
		height: 650,
		x: 200,
		y: 200,
	},
});

console.log("Notes app started!");
console.log(`Notes stored in: ${notesDir}`);
