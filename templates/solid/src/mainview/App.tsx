import { createSignal } from "solid-js";

export default function App() {
	const [count, setCount] = createSignal(0);

	return (
		<main>
			<div class="container">
				<h1>Solid + Electrobun</h1>
				<p class="subtitle">A fast desktop app with hot module replacement</p>

				<div class="card">
					<h2>Interactive Counter</h2>
					<p>
						Click the button below to test Solid reactivity. With HMR enabled, you
						can edit this component and see changes instantly.
					</p>
					<div class="button-group">
						<button class="primary" onClick={() => setCount(count() + 1)}>
							Count: {count()}
						</button>
						<button class="secondary" onClick={() => setCount(0)}>
							Reset
						</button>
					</div>
				</div>

				<div class="card">
					<h2>Getting Started</h2>
					<ul>
						<li>
							<span class="number">1.</span>
							Run <code>bun run dev</code> for development without HMR
						</li>
						<li>
							<span class="number">2.</span>
							Run <code>bun run dev:hmr</code> for development with hot reload
						</li>
						<li>
							<span class="number">3.</span>
							Run <code>bun run build</code> to build for production
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
							<span class="icon">💎</span>
							<span>SolidJS</span>
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
						Edit <code>src/mainview/App.tsx</code> and save to see HMR in action
					</p>
				</div>
			</div>
		</main>
	);
}
