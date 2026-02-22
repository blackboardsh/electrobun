import "./style.css";

const app = document.getElementById("app")!;

let count = 0;

function render() {
	app.innerHTML = `
		<main class="min-h-screen bg-gradient-to-br from-cyan-500 to-blue-600 p-10">
			<div class="max-w-3xl mx-auto">
				<h1 class="text-5xl font-bold text-white text-center mb-2 drop-shadow-lg">
					Tailwind + Electrobun
				</h1>
				<p class="text-xl text-white/90 text-center mb-10">
					A fast desktop app with Tailwind CSS — no framework needed
				</p>

				<div class="bg-white rounded-xl p-8 mb-5 shadow-lg">
					<h2 class="text-xl font-semibold text-cyan-600 mb-3">Interactive Counter</h2>
					<p class="text-gray-500 leading-relaxed mb-5">
						Click the button below to test interactivity. With HMR enabled,
						you can edit this file and see changes instantly.
					</p>
					<div class="flex gap-3">
						<button id="increment-btn"
							class="px-6 py-3 bg-cyan-500 text-white font-medium rounded-lg hover:bg-cyan-600 hover:-translate-y-0.5 transition-all shadow-md">
							Count: ${count}
						</button>
						<button id="reset-btn"
							class="px-6 py-3 bg-gray-100 text-gray-600 font-medium rounded-lg hover:bg-gray-200 transition-all">
							Reset
						</button>
					</div>
				</div>

				<div class="bg-white rounded-xl p-8 mb-5 shadow-lg">
					<h2 class="text-xl font-semibold text-cyan-600 mb-3">Getting Started</h2>
					<ul class="space-y-3">
						<li class="flex items-start gap-2 text-gray-500">
							<span class="text-cyan-600 font-bold">1.</span>
							Run <code class="bg-gray-100 px-2 py-0.5 rounded text-sm font-mono">bun run dev</code> for development without HMR
						</li>
						<li class="flex items-start gap-2 text-gray-500">
							<span class="text-cyan-600 font-bold">2.</span>
							Run <code class="bg-gray-100 px-2 py-0.5 rounded text-sm font-mono">bun run dev:hmr</code> for development with hot reload
						</li>
						<li class="flex items-start gap-2 text-gray-500">
							<span class="text-cyan-600 font-bold">3.</span>
							Run <code class="bg-gray-100 px-2 py-0.5 rounded text-sm font-mono">bun run build</code> to build for production
						</li>
					</ul>
				</div>

				<div class="bg-white rounded-xl p-8 mb-5 shadow-lg">
					<h2 class="text-xl font-semibold text-cyan-600 mb-3">Stack</h2>
					<div class="grid grid-cols-4 gap-4">
						<div class="text-center p-5 bg-gray-50 rounded-lg">
							<span class="block text-3xl mb-2">⚡</span>
							<span class="text-gray-700">Electrobun</span>
						</div>
						<div class="text-center p-5 bg-gray-50 rounded-lg">
							<span class="block text-3xl mb-2">🎨</span>
							<span class="text-gray-700">Tailwind</span>
						</div>
						<div class="text-center p-5 bg-gray-50 rounded-lg">
							<span class="block text-3xl mb-2">🔥</span>
							<span class="text-gray-700">Vite HMR</span>
						</div>
						<div class="text-center p-5 bg-gray-50 rounded-lg">
							<span class="block text-3xl mb-2">📦</span>
							<span class="text-gray-700">Bun</span>
						</div>
					</div>
				</div>

				<div class="text-center text-white/80 mt-8 p-5 bg-white/10 rounded-lg backdrop-blur">
					<p>
						Edit <code class="bg-white/20 text-white px-2 py-0.5 rounded text-sm font-mono">src/mainview/main.ts</code> and save to see HMR in action
					</p>
				</div>
			</div>
		</main>
	`;

	document.getElementById("increment-btn")!.addEventListener("click", () => {
		count++;
		render();
	});

	document.getElementById("reset-btn")!.addEventListener("click", () => {
		count = 0;
		render();
	});
}

render();
