import { createSignal, onMount, onCleanup, Show } from "solid-js";

export default function App() {
	const [fps, setFps] = createSignal(0);
	const [frameTime, setFrameTime] = createSignal(0);
	const [cubeCount, setCubeCount] = createSignal(0);
	const [connected, setConnected] = createSignal(false);
	const [dropRate, setDropRate] = createSignal(300);
	const [cubeSize, setCubeSize] = createSignal(0.4);
	const [showControls, setShowControls] = createSignal(true);

	onMount(() => {
		(window as any).__updateDCompStats = (f: number, ft: number, cc: number) => {
			setFps(f);
			setFrameTime(ft);
			setCubeCount(cc);
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
							Three.js WGPU + SolidJS + TailwindCSS + DirectComposition
						</p>
					</div>

					<div class="flex gap-6">
						<Stat value={fps()} label="FPS" color="text-lime-400" />
						<Stat value={`${frameTime().toFixed(1)}`} label="ms/frame" color="text-lime-400" />
						<Stat value={cubeCount()} label="Cubes" color="text-lime-400" />
					</div>
				</div>
			</div>

			{/* Middle — controls (collapsible) */}
			<div class="flex-1 flex items-center justify-center">
				<Show when={showControls()} fallback={
					<button
						class="px-4 py-2 bg-slate-900/50 backdrop-blur-sm border border-cyan-400/20 rounded-lg text-xs text-cyan-400 hover:bg-slate-900/70 transition-colors cursor-pointer"
						onClick={() => setShowControls(true)}
					>
						Show Controls
					</button>
				}>
					<div class="bg-slate-900/50 backdrop-blur-sm border border-cyan-400/10 rounded-2xl p-8 max-w-lg w-full relative">
						<button
							class="absolute top-3 right-3 w-7 h-7 flex items-center justify-center text-slate-500 hover:text-white bg-slate-800/60 hover:bg-slate-700/80 rounded-md transition-colors cursor-pointer text-sm"
							onClick={() => setShowControls(false)}
						>
							x
						</button>

						<h2 class="text-lg font-medium text-white mb-4">Physics Controls</h2>
						<p class="text-sm text-slate-400 mb-6">
							SolidJS signals drive these sliders. Changes are sent to the Three.js
							physics engine via Electrobun RPC. Native WGPU rendering composites
							behind this transparent UI via DirectComposition.
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

						{/* Stack badges */}
						<div class="grid grid-cols-5 gap-3">
							<StackBadge label="Three.js" />
							<StackBadge label="SolidJS" />
							<StackBadge label="Tailwind" />
							<StackBadge label="DComp" />
							<StackBadge label="Dawn DX12" />
						</div>
					</div>
				</Show>
			</div>

			{/* Bottom HUD */}
			<div class="bg-slate-900/60 backdrop-blur-md border border-cyan-400/15 rounded-xl px-5 py-3 text-center">
				<p class="text-xs text-slate-500">
					<span class="text-cyan-400 font-semibold">Dawn/WGPU</span> native GPU rendering
					{" + "}
					<span class="text-cyan-400 font-semibold">DirectComposition</span> compositing
					{" + "}
					<span class="text-cyan-400 font-semibold">SolidJS</span> reactive HUD
					{" + "}
					<span class="text-cyan-400 font-semibold">TailwindCSS</span> styling
					{" — "}
					<span class={connected() ? "text-lime-400" : "text-amber-400"}>
						{connected() ? "connected" : "waiting..."}
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
