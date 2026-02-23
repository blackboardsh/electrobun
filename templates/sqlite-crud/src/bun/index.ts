import { BrowserView, BrowserWindow, Utils, type RPCSchema } from "electrobun/bun";
import Database from "bun:sqlite";
import { join } from "path";
import { mkdirSync, existsSync } from "fs";

// Ensure data directory exists
const dataDir = Utils.paths.userData;
if (!existsSync(dataDir)) {
	mkdirSync(dataDir, { recursive: true });
}

// Initialize SQLite database
const dbPath = join(dataDir, "todos.db");
const db = new Database(dbPath, { create: true });

// Create table
db.exec(`
	CREATE TABLE IF NOT EXISTS todos (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		title TEXT NOT NULL,
		completed INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		updated_at TEXT NOT NULL DEFAULT (datetime('now'))
	)
`);

// Prepared statements
const getAllTodos = db.prepare("SELECT * FROM todos ORDER BY created_at DESC");
const getTodoById = db.prepare("SELECT * FROM todos WHERE id = ?");
const insertTodo = db.prepare("INSERT INTO todos (title) VALUES (?) RETURNING *");
const updateTodoTitle = db.prepare("UPDATE todos SET title = ?, updated_at = datetime('now') WHERE id = ? RETURNING *");
const toggleTodo = db.prepare("UPDATE todos SET completed = NOT completed, updated_at = datetime('now') WHERE id = ? RETURNING *");
const deleteTodo = db.prepare("DELETE FROM todos WHERE id = ?");
const deleteCompleted = db.prepare("DELETE FROM todos WHERE completed = 1");
const getStats = db.prepare("SELECT COUNT(*) as total, SUM(completed) as completed FROM todos");

type Todo = {
	id: number;
	title: string;
	completed: number;
	created_at: string;
	updated_at: string;
};

type Stats = {
	total: number;
	completed: number;
};

type TodoRPC = {
	bun: RPCSchema<{
		requests: {
			getTodos: {
				params: {};
				response: Todo[];
			};
			addTodo: {
				params: { title: string };
				response: Todo;
			};
			updateTodo: {
				params: { id: number; title: string };
				response: Todo;
			};
			toggleTodo: {
				params: { id: number };
				response: Todo;
			};
			deleteTodo: {
				params: { id: number };
				response: { success: boolean };
			};
			clearCompleted: {
				params: {};
				response: { deleted: number };
			};
			getStats: {
				params: {};
				response: Stats;
			};
		};
		messages: {};
	}>;
	webview: RPCSchema<{
		requests: {};
		messages: {};
	}>;
};

const todoRPC = BrowserView.defineRPC<TodoRPC>({
	maxRequestTime: 5000,
	handlers: {
		requests: {
			getTodos: () => {
				return getAllTodos.all() as Todo[];
			},
			addTodo: ({ title }) => {
				return insertTodo.get(title) as Todo;
			},
			updateTodo: ({ id, title }) => {
				return updateTodoTitle.get(title, id) as Todo;
			},
			toggleTodo: ({ id }) => {
				return toggleTodo.get(id) as Todo;
			},
			deleteTodo: ({ id }) => {
				deleteTodo.run(id);
				return { success: true };
			},
			clearCompleted: () => {
				const result = deleteCompleted.run();
				return { deleted: result.changes };
			},
			getStats: () => {
				const row = getStats.get() as any;
				return { total: row.total, completed: row.completed || 0 };
			},
		},
		messages: {},
	},
});

const mainWindow = new BrowserWindow({
	title: "SQLite Todo App",
	url: "views://mainview/index.html",
	rpc: todoRPC,
	frame: {
		width: 700,
		height: 600,
		x: 200,
		y: 200,
	},
});

console.log("SQLite Todo app started!");
console.log(`Database: ${dbPath}`);
