import Electrobun, { Electroview } from "electrobun/view";

type Todo = {
	id: number;
	title: string;
	completed: number;
	created_at: string;
	updated_at: string;
};

type TodoRPC = {
	bun: {
		requests: {
			getTodos: { params: {}; response: Todo[] };
			addTodo: { params: { title: string }; response: Todo };
			updateTodo: { params: { id: number; title: string }; response: Todo };
			toggleTodo: { params: { id: number }; response: Todo };
			deleteTodo: { params: { id: number }; response: { success: boolean } };
			clearCompleted: { params: {}; response: { deleted: number } };
			getStats: { params: {}; response: { total: number; completed: number } };
		};
		messages: {};
	};
	webview: {
		requests: {};
		messages: {};
	};
};

const rpc = Electroview.defineRPC<TodoRPC>({
	maxRequestTime: 5000,
	handlers: { requests: {}, messages: {} },
});

const electrobun = new Electrobun.Electroview({ rpc });

// DOM
const todoInput = document.getElementById("new-todo") as HTMLInputElement;
const addBtn = document.getElementById("add-btn") as HTMLButtonElement;
const todoList = document.getElementById("todo-list") as HTMLUListElement;
const statsDiv = document.getElementById("stats") as HTMLDivElement;
const clearBtn = document.getElementById("clear-completed") as HTMLButtonElement;
const filterBtns = document.querySelectorAll(".filter");

let todos: Todo[] = [];
let currentFilter = "all";

async function loadTodos() {
	todos = await electrobun.rpc!.request.getTodos({});
	renderTodos();
	updateStats();
}

function getFilteredTodos(): Todo[] {
	switch (currentFilter) {
		case "active":
			return todos.filter((t) => !t.completed);
		case "completed":
			return todos.filter((t) => t.completed);
		default:
			return todos;
	}
}

function renderTodos() {
	const filtered = getFilteredTodos();

	if (filtered.length === 0) {
		todoList.innerHTML = '<li class="empty-state">No todos to show</li>';
		return;
	}

	todoList.innerHTML = filtered
		.map((todo) => {
			const date = new Date(todo.created_at + "Z");
			const dateStr = date.toLocaleDateString(undefined, {
				month: "short",
				day: "numeric",
			});
			return `
				<li class="todo-item${todo.completed ? " completed" : ""}" data-id="${todo.id}">
					<input type="checkbox" ${todo.completed ? "checked" : ""} />
					<span class="todo-text">${escapeHtml(todo.title)}</span>
					<span class="todo-date">${dateStr}</span>
					<button class="delete-btn">&times;</button>
				</li>
			`;
		})
		.join("");

	// Attach event listeners
	todoList.querySelectorAll(".todo-item").forEach((item) => {
		const id = parseInt((item as HTMLElement).dataset.id!);

		item.querySelector("input[type='checkbox']")!.addEventListener("change", async () => {
			await electrobun.rpc!.request.toggleTodo({ id });
			await loadTodos();
		});

		item.querySelector(".delete-btn")!.addEventListener("click", async () => {
			await electrobun.rpc!.request.deleteTodo({ id });
			await loadTodos();
		});
	});
}

async function updateStats() {
	const stats = await electrobun.rpc!.request.getStats({});
	const active = stats.total - stats.completed;
	statsDiv.textContent = `${active} item${active !== 1 ? "s" : ""} left, ${stats.completed} completed`;
}

function escapeHtml(str: string): string {
	const div = document.createElement("div");
	div.textContent = str;
	return div.innerHTML;
}

// Add todo
async function addTodo() {
	const title = todoInput.value.trim();
	if (!title) return;
	await electrobun.rpc!.request.addTodo({ title });
	todoInput.value = "";
	await loadTodos();
}

addBtn.addEventListener("click", addTodo);
todoInput.addEventListener("keydown", (e) => {
	if (e.key === "Enter") addTodo();
});

// Filters
filterBtns.forEach((btn) => {
	btn.addEventListener("click", () => {
		currentFilter = (btn as HTMLElement).dataset.filter!;
		filterBtns.forEach((b) => b.classList.remove("active"));
		btn.classList.add("active");
		renderTodos();
	});
});

// Clear completed
clearBtn.addEventListener("click", async () => {
	await electrobun.rpc!.request.clearCompleted({});
	await loadTodos();
});

// Initial load
loadTodos();
