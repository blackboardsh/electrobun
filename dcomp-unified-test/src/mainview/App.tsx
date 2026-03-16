import { createSignal, onMount, onCleanup } from "solid-js";

export default function App() {
	const [fps, setFps] = createSignal(0);
	const [frameTime, setFrameTime] = createSignal(0);
	const [frameCount, setFrameCount] = createSignal(0);
	const [clicks, setClicks] = createSignal(0);
	const [connected, setConnected] = createSignal(false);
	const [dropRate, setDropRate] = createSignal(300);
	const [cubeSize, setCubeSize] = createSignal(0.4);

	onMount(() => {
		(window as any).__updateDCompStats = (f: number, ft: number, fc: number) => {
			setFps(f);
			setFrameTime(ft);
			setFrameCount(fc);
			if (!connected()) setConnected(true);
		};
	});

	onCleanup(() => {
		delete (window as any).__updateDCompStats;
	});

	function handleDropRate(ms: number) {
		setDropRate(ms);
		(window as any).__rpcSend?.setDropRate(ms);
	}

	function handleCubeSize(size: number) {
		setCubeSize(size);
		(window as any).__rpcSend?.setCubeSize(size);
	}

	return (
		<div class="h-screen flex flex-col justify-between p-5 select-none">
			{/* Top HUD */}
			<div class="bg-slate-900/70 backdrop-blur-md border border-cyan-400/20 rounded-xl p-4">
				<div class="flex items-center justify-between">
					<div>
						<h1 class="text-xl font-light tracking-[0.2em] uppercase text-cyan-400 drop-shadow-[0_0_12px_rgba(0,212,255,0.4)]">
							Unified Demo
						</h1>
						<p class="text-xs text-slate-500 mt-1">
							Three.js + SolidJS + TailwindCSS + DirectComposition
						</p>
					</div>

					<div class="flex gap-6">
						<Stat value={fps()} label="GPU FPS" color="text-lime-400" />
						<Stat value={`${frameTime().toFixed(2)}`} label="ms/frame" color="text-lime-400" />
						<Stat value={frameCount()} label="Frames" color="text-lime-400" />
					</div>
				</div>
			</div>

			{/* Middle — controls + counter */}
			<div class="flex-1 flex items-center justify-center">
				<div class="bg-slate-900/50 backdrop-blur-sm border border-cyan-400/10 rounded-2xl p-8 max-w-lg w-full">
					<h2 class="text-lg font-medium text-white mb-4">Physics Controls</h2>
					<p class="text-sm text-slate-400 mb-6">
						SolidJS signals drive these sliders. Changes are sent to the Three.js
						physics engine via Electrobun RPC. The DComp triangle spins behind this panel.
					</p>

					{/* Sliders */}
					<div class="space-y-4 mb-6">
						<div>
							<div class="flex justify-between text-xs text-slate-500 mb-1">
								<span>Drop rate</span>
								<span class="text-cyan-400 tabular-nums">{dropRate()}ms</span>
							</div>
							<input
								type="range"
								min="100"
								max="1200"
								step="50"
								value={dropRate()}
								onInput={(e) => handleDropRate(Number(e.currentTarget.value))}
								class="w-full accent-cyan-400 cursor-pointer"
							/>
						</div>
						<div>
							<div class="flex justify-between text-xs text-slate-500 mb-1">
								<span>Cube size</span>
								<span class="text-cyan-400 tabular-nums">{cubeSize().toFixed(2)}</span>
							</div>
							<input
								type="range"
								min="0.2"
								max="1.2"
								step="0.05"
								value={cubeSize()}
								onInput={(e) => handleCubeSize(Number(e.currentTarget.value))}
								class="w-full accent-cyan-400 cursor-pointer"
							/>
						</div>
					</div>

					{/* Counter */}
					<div class="flex gap-3 mb-6">
						<button
							class="px-6 py-3 bg-cyan-500 hover:bg-cyan-400 text-slate-900 font-semibold rounded-lg transition-colors cursor-pointer"
							onClick={() => setClicks(c => c + 1)}
						>
							Clicks: {clicks()}
						</button>
						<button
							class="px-6 py-3 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-lg transition-colors cursor-pointer"
							onClick={() => setClicks(0)}
						>
							Reset
						</button>
					</div>

					{/* Stack badges */}
					<div class="grid grid-cols-5 gap-3">
						<StackBadge label="Three.js" />
						<StackBadge label="SolidJS" />
						<StackBadge label="Tailwind" />
						<StackBadge label="DComp" />
						<StackBadge label="WebGPU" />
					</div>
				</div>
			</div>

			{/* Bottom HUD */}
			<div class="bg-slate-900/60 backdrop-blur-md border border-cyan-400/15 rounded-xl px-5 py-3 text-center">
				<p class="text-xs text-slate-500">
					<span class="text-cyan-400 font-semibold">DirectComposition</span> GPU back layer
					{" + "}
					<span class="text-cyan-400 font-semibold">Three.js</span> physics window
					{" + "}
					<span class="text-cyan-400 font-semibold">SolidJS</span> reactive HUD
					{" + "}
					<span class="text-cyan-400 font-semibold">TailwindCSS</span> styling
					{" — "}
					<span class={connected() ? "text-lime-400" : "text-amber-400"}>
						{connected() ? "connected" : "waiting for DComp..."}
					</span>
				</p>
			</div>
		</div>
	);
}

function Stat(props: { value: number | string; label: string; color: string }) {
	return (
		<div class="text-center">
			<div class={`text-xl font-extralight tabular-nums ${props.color}`}>
				{props.value || "--"}
			</div>
			<div class="text-[9px] uppercase tracking-widest text-slate-600">{props.label}</div>
		</div>
	);
}

function StackBadge(props: { label: string }) {
	return (
		<div class="bg-slate-800/80 border border-slate-700 rounded-lg py-2 text-center text-xs text-slate-400">
			{props.label}
		</div>
	);
}
