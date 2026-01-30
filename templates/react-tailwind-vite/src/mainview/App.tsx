import { useState } from "react";

function App() {
	const [count, setCount] = useState(0);

	return (
		<div className="min-h-screen bg-gradient-to-br from-indigo-500 to-purple-600 text-gray-900">
			<div className="container mx-auto px-4 py-10 max-w-3xl">
				<h1 className="text-5xl font-bold text-center text-white mb-2 drop-shadow-lg">
					React + Tailwind + Vite
				</h1>
				<p className="text-xl text-center text-white/90 mb-10">
					A fast Electrobun app with hot module replacement
				</p>

				<div className="bg-white rounded-xl shadow-xl p-8 mb-8">
					<h2 className="text-2xl font-semibold text-indigo-600 mb-4">
						Interactive Counter
					</h2>
					<p className="mb-4 text-gray-600">
						Click the button below to test React state. With HMR enabled, you
						can edit this component and see changes instantly without losing
						state.
					</p>
					<div className="flex items-center gap-4">
						<button
							onClick={() => setCount((c) => c + 1)}
							className="px-6 py-3 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-700 transition-colors shadow-md hover:shadow-lg"
						>
							Count: {count}
						</button>
						<button
							onClick={() => setCount(0)}
							className="px-4 py-3 bg-gray-200 text-gray-700 font-medium rounded-lg hover:bg-gray-300 transition-colors"
						>
							Reset
						</button>
					</div>
				</div>

				<div className="bg-white rounded-xl shadow-xl p-8 mb-8">
					<h2 className="text-2xl font-semibold text-indigo-600 mb-4">
						Getting Started
					</h2>
					<ul className="space-y-3 text-gray-700">
						<li className="flex items-start gap-2">
							<span className="text-indigo-500 font-bold">1.</span>
							<span>
								Run{" "}
								<code className="bg-gray-100 px-2 py-1 rounded text-sm">
									bun run dev
								</code>{" "}
								for development without HMR
							</span>
						</li>
						<li className="flex items-start gap-2">
							<span className="text-indigo-500 font-bold">2.</span>
							<span>
								Run{" "}
								<code className="bg-gray-100 px-2 py-1 rounded text-sm">
									bun run dev:hmr
								</code>{" "}
								for development with hot reload
							</span>
						</li>
						<li className="flex items-start gap-2">
							<span className="text-indigo-500 font-bold">3.</span>
							<span>
								Run{" "}
								<code className="bg-gray-100 px-2 py-1 rounded text-sm">
									bun run build
								</code>{" "}
								to build for production
							</span>
						</li>
					</ul>
				</div>

				<div className="bg-white rounded-xl shadow-xl p-8">
					<h2 className="text-2xl font-semibold text-indigo-600 mb-4">Stack</h2>
					<div className="grid grid-cols-2 md:grid-cols-4 gap-4">
						<div className="text-center p-4 bg-gray-50 rounded-lg">
							<div className="text-3xl mb-2">⚡</div>
							<div className="font-medium">Electrobun</div>
						</div>
						<div className="text-center p-4 bg-gray-50 rounded-lg">
							<div className="text-3xl mb-2">⚛️</div>
							<div className="font-medium">React</div>
						</div>
						<div className="text-center p-4 bg-gray-50 rounded-lg">
							<div className="text-3xl mb-2">🎨</div>
							<div className="font-medium">Tailwind</div>
						</div>
						<div className="text-center p-4 bg-gray-50 rounded-lg">
							<div className="text-3xl mb-2">🔥</div>
							<div className="font-medium">Vite HMR</div>
						</div>
					</div>
				</div>

				<div className="text-center text-white/80 mt-10 p-6 bg-white/10 rounded-lg backdrop-blur">
					<p>
						Edit{" "}
						<code className="bg-white/20 px-2 py-1 rounded text-sm">
							src/mainview/App.tsx
						</code>{" "}
						and save to see HMR in action
					</p>
				</div>
			</div>
		</div>
	);
}

export default App;
