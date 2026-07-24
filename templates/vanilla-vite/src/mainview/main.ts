import "./style.css";

const app = document.getElementById("app")!;

let count = 0;

function render() {
	app.innerHTML = `
		<main>
			<div class="container">
				<h1>Vanilla + Electrobun</h1>
				<p class="subtitle">A fast desktop app with hot module replacement — no framework needed</p>

				<div class="card">
					<h2>Interactive Counter</h2>
					<p>
						Click the button below to test vanilla TypeScript. With HMR enabled,
						you can edit this file and see changes instantly.
					</p>
					<div class="button-group">
						<button class="primary" id="increment-btn">
							Count: ${count}
						</button>
						<button class="secondary" id="reset-btn">
							Reset
						</button>
					</div>
				</div>

				<div class="card">
					<h2>Getting Started</h2>
					<ul>
						<li>
							<span class="number">1.</span>
							Run <code>dash run dev</code> for development without HMR
						</li>
						<li>
							<span class="number">2.</span>
							Run <code>dash run dev:hmr</code> for development with hot reload
						</li>
						<li>
							<span class="number">3.</span>
							Run <code>dash run build:canary</code> to build a canary release
						</li>
					</ul>
				</div>

				<div class="card">
					<h2>Stack</h2>
					<div class="stack-grid">
						<div class="stack-item">
							<span class="icon">⚡</span>
							<span>Electrobun</span>
						</div>
						<div class="stack-item">
							<span class="icon">🟦</span>
							<span>TypeScript</span>
						</div>
						<div class="stack-item">
							<span class="icon">🔥</span>
							<span>Vite HMR</span>
						</div>
						<div class="stack-item">
							<span class="icon">📦</span>
							<span>Bun</span>
						</div>
					</div>
				</div>

				<div class="footer">
					<p>
						Edit <code>src/mainview/main.ts</code> and save to see HMR in action
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
