import { Component } from "@angular/core";

@Component({
	selector: "app-root",
	standalone: true,
	template: `
		<main>
			<div class="container">
				<h1>Angular + Electrobun</h1>
				<p class="subtitle">A fast desktop app with hot module replacement</p>

				<div class="card">
					<h2>Interactive Counter</h2>
					<p>
						Click the button below to test Angular reactivity. With HMR enabled,
						you can edit this component and see changes instantly.
					</p>
					<div class="button-group">
						<button class="primary" (click)="increment()">
							Count: {{ count }}
						</button>
						<button class="secondary" (click)="reset()">
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
							<span class="icon">🅰️</span>
							<span>Angular 19</span>
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
						Edit <code>src/mainview/app/app.component.ts</code> and save to see HMR in action
					</p>
				</div>
			</div>
		</main>
	`,
	styles: [`
		main {
			min-height: 100vh;
			background: linear-gradient(135deg, #dd0031 0%, #c3002f 100%);
			padding: 40px 20px;
		}

		.container {
			max-width: 800px;
			margin: 0 auto;
		}

		h1 {
			color: white;
			font-size: 3rem;
			text-align: center;
			margin-bottom: 8px;
			text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
		}

		.subtitle {
			color: rgba(255, 255, 255, 0.9);
			font-size: 1.25rem;
			text-align: center;
			margin-top: 0;
			margin-bottom: 40px;
			text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
		}

		.card {
			background: white;
			border-radius: 12px;
			padding: 30px;
			margin-bottom: 20px;
			box-shadow: 0 8px 25px rgba(0, 0, 0, 0.15);
		}

		h2 {
			color: #dd0031;
			margin-top: 0;
			margin-bottom: 15px;
		}

		p {
			color: #666;
			line-height: 1.6;
		}

		.button-group {
			display: flex;
			gap: 12px;
			margin-top: 20px;
		}

		button {
			padding: 12px 24px;
			font-size: 1rem;
			font-weight: 500;
			border: none;
			border-radius: 8px;
			cursor: pointer;
			transition: all 0.2s ease;
		}

		button.primary {
			background: #dd0031;
			color: white;
			box-shadow: 0 2px 4px rgba(221, 0, 49, 0.3);
		}

		button.primary:hover {
			background: #c3002f;
			transform: translateY(-1px);
			box-shadow: 0 4px 8px rgba(221, 0, 49, 0.4);
		}

		button.secondary {
			background: #f0f0f0;
			color: #666;
		}

		button.secondary:hover {
			background: #e0e0e0;
		}

		ul {
			list-style: none;
			padding: 0;
			margin: 0;
		}

		li {
			display: flex;
			align-items: flex-start;
			gap: 10px;
			padding: 10px 0;
			color: #666;
		}

		.number {
			color: #dd0031;
			font-weight: bold;
		}

		code {
			background: #f5f5f5;
			color: #555;
			padding: 2px 8px;
			border-radius: 4px;
			font-family: "Monaco", "Menlo", monospace;
			font-size: 0.9em;
		}

		.stack-grid {
			display: grid;
			grid-template-columns: repeat(4, 1fr);
			gap: 15px;
		}

		.stack-item {
			text-align: center;
			padding: 20px 10px;
			background: #fafafa;
			border-radius: 8px;
		}

		.icon {
			display: block;
			font-size: 2rem;
			margin-bottom: 8px;
		}

		.footer {
			text-align: center;
			color: rgba(255, 255, 255, 0.8);
			margin-top: 30px;
			padding: 20px;
			background: rgba(255, 255, 255, 0.1);
			border-radius: 8px;
			backdrop-filter: blur(10px);
		}

		.footer p {
			color: inherit;
			margin: 0;
		}

		.footer code {
			background: rgba(255, 255, 255, 0.2);
			color: white;
		}

		@media (max-width: 600px) {
			.stack-grid {
				grid-template-columns: repeat(2, 1fr);
			}
		}
	`],
})
export class AppComponent {
	count = 0;

	increment() {
		this.count++;
	}

	reset() {
		this.count = 0;
	}
}
