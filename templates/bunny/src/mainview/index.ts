import Electrobun, { Electroview } from "electrobun/view";

const bunny = document.getElementById("bunny") as HTMLDivElement;

// Create depth layers behind the front image for a thick 3D look
const frontImg = bunny.querySelector("img") as HTMLImageElement;
const DEPTH_LAYERS = 12;
const LAYER_SPACING = 0.8; // px between each layer

for (let i = 1; i <= DEPTH_LAYERS; i++) {
	const layer = frontImg.cloneNode(true) as HTMLImageElement;
	layer.style.position = "absolute";
	layer.style.top = "0";
	layer.style.left = "0";
	layer.style.transform = `translateZ(${-i * LAYER_SPACING}px)`;
	// Darken deeper layers to simulate shading on the edge
	const brightness = Math.max(0.25, 1 - i * 0.06);
	layer.style.filter = `brightness(${brightness}) ${frontImg.style.filter || ""}`;
	layer.setAttribute("aria-hidden", "true");
	bunny.insertBefore(layer, frontImg);
}

// --- Electric spark effect on hover (WebGL shader) ---
const sparkCanvas = document.createElement("canvas");
sparkCanvas.className = "spark-canvas";
bunny.appendChild(sparkCanvas);

// Sparks are optional: cursor tracking and CSS rotation work without WebGL.
sparkCanvas.style.display = "none";

const vsSource = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const fsSource = `
precision mediump float;
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_intensity;

float hash1(float n) {
	return fract(sin(n) * 43758.5453);
}

// 4-pointed star SDF: sharp diamond spikes along axes
float starSDF(vec2 p, float size) {
	p = abs(p);
	// Thin along each axis — the min of two perpendicular thin diamonds
	float spike = min(p.x + p.y * 3.0, p.y + p.x * 3.0);
	float bounds = (p.x + p.y); // diamond boundary
	return max(spike - size, bounds - size);
}

void main() {
	vec2 uv = gl_FragCoord.xy / u_resolution;
	uv.y = 1.0 - uv.y;

	if (u_intensity <= 0.001) {
		gl_FragColor = vec4(0.0);
		return;
	}

	float t = u_time;
	vec3 color = vec3(0.0);
	float total = 0.0;

	vec2 starCenter = vec2(0.68, 0.28);

	// 10 flickering 4-pointed stars
	for (int i = 0; i < 10; i++) {
		float fi = float(i);
		float seed = fi * 13.7;

		// Position: scattered around the star region
		vec2 pos = starCenter + (vec2(hash1(seed + 1.0), hash1(seed + 2.0)) - 0.5) * 0.35;

		// Size: varies per star
		float baseSize = 0.015 + hash1(seed + 3.0) * 0.030;

		// Flicker timing: sharp pop in/out
		float phase = hash1(seed + 4.0) * 6.28;
		float speed = 1.5 + hash1(seed + 5.0) * 4.0;
		float wave = sin(t * speed + phase);
		float flicker = smoothstep(0.2, 0.5, wave) * smoothstep(1.0, 0.7, wave);
		if (flicker < 0.01) continue;

		// Slight rotation over time
		float angle = hash1(seed + 6.0) * 3.14 + t * (0.5 + hash1(seed + 7.0));
		float ca = cos(angle);
		float sa = sin(angle);
		vec2 d = uv - pos;
		vec2 rd = vec2(d.x * ca - d.y * sa, d.x * sa + d.y * ca);

		// Scale pulse — breathes slightly
		float pulse = 1.0 + 0.3 * sin(t * speed * 1.5 + phase);
		float size = baseSize * pulse;

		float dist = starSDF(rd, size);

		// Core: sharp bright shape
		float core = smoothstep(0.002, 0.0, dist);
		// Glow: softer halo
		float glow = smoothstep(size * 0.8, 0.0, dist) * 0.3;
		float val = (core + glow) * flicker;

		// Color: blue or yellow
		vec3 c;
		if (hash1(seed + 8.0) < 0.5) {
			c = mix(vec3(0.31, 0.76, 0.97), vec3(0.0, 0.9, 1.0), hash1(seed + 9.0));
		} else {
			c = mix(vec3(1.0, 0.92, 0.23), vec3(1.0, 0.84, 0.0), hash1(seed + 9.0));
		}

		color += c * val;
		total += val;
	}

	color *= u_intensity;
	total *= u_intensity;

	gl_FragColor = vec4(color * total, total);
}
`;

function createSparkEffect() {
	let gl: WebGLRenderingContext | null = null;
	const shaders: WebGLShader[] = [];
	let program: WebGLProgram | null = null;
	let buffer: WebGLBuffer | null = null;
	let observer: ResizeObserver | undefined;
	let enabled = true;
	let visible = false;
	const disable = () => {
		enabled = false;
		sparkCanvas.style.display = "none";
		observer?.disconnect();
		// Cleanup is best effort when the context itself has failed.
		try {
			if (gl && !gl.isContextLost()) {
				if (buffer) gl.deleteBuffer(buffer);
				if (program) gl.deleteProgram(program);
				for (const shader of shaders) gl.deleteShader(shader);
			}
		} catch {}
	};
	try {
		const context = sparkCanvas.getContext("webgl", {
			alpha: true,
			premultipliedAlpha: true,
			antialias: false,
		});
		if (!context || context.isContextLost()) return null;
		gl = context;
		const compileShader = (src: string, type: number) => {
			const shader = context.createShader(type);
			if (!shader) throw new Error("Spark shader allocation failed");
			shaders.push(shader);
			context.shaderSource(shader, src);
			context.compileShader(shader);
			if (!context.getShaderParameter(shader, context.COMPILE_STATUS)) {
				throw new Error("Spark shader compilation failed");
			}
			return shader;
		};
		const vs = compileShader(vsSource, context.VERTEX_SHADER);
		const fs = compileShader(fsSource, context.FRAGMENT_SHADER);
		program = context.createProgram();
		if (!program) throw new Error("Spark program allocation failed");
		context.attachShader(program, vs);
		context.attachShader(program, fs);
		context.linkProgram(program);
		if (!context.getProgramParameter(program, context.LINK_STATUS)) {
			throw new Error("Spark program linking failed");
		}
		context.useProgram(program);

		// Fullscreen quad
		buffer = context.createBuffer();
		if (!buffer) throw new Error("Spark buffer allocation failed");
		context.bindBuffer(context.ARRAY_BUFFER, buffer);
		context.bufferData(context.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), context.STATIC_DRAW);
		const aPos = context.getAttribLocation(program, "a_pos");
		const uTime = context.getUniformLocation(program, "u_time");
		const uResolution = context.getUniformLocation(program, "u_resolution");
		const uIntensity = context.getUniformLocation(program, "u_intensity");
		if (aPos < 0 || !uTime || !uResolution || !uIntensity) throw new Error("Spark shader inputs unavailable");
		context.enableVertexAttribArray(aPos);
		context.vertexAttribPointer(aPos, 2, context.FLOAT, false, 0, 0);
		context.enable(context.BLEND);
		context.blendFunc(context.ONE, context.ONE_MINUS_SRC_ALPHA);

		const resizeCanvas = () => {
			if (!enabled) return;
			try {
				if (context.isContextLost()) { disable(); return; }
				const rect = bunny.getBoundingClientRect();
				sparkCanvas.width = Math.round(rect.width * devicePixelRatio);
				sparkCanvas.height = Math.round(rect.height * devicePixelRatio);
				context.viewport(0, 0, sparkCanvas.width, sparkCanvas.height);
			} catch { disable(); }
		};
		resizeCanvas();
		if (!enabled) return null;
		observer = new ResizeObserver(resizeCanvas);
		observer.observe(bunny);
		sparkCanvas.addEventListener("webglcontextlost", disable);
		return {
			draw(time: number, intensity: number) {
				if (!enabled) return;
				try {
					if (context.isContextLost()) { disable(); return; }
					if (intensity > 0.001) {
						if (!visible) { sparkCanvas.style.display = ""; visible = true; }
						context.uniform1f(uTime, time / 1000);
						context.uniform2f(uResolution, sparkCanvas.width, sparkCanvas.height);
						context.uniform1f(uIntensity, intensity);
						context.clear(context.COLOR_BUFFER_BIT);
						context.drawArrays(context.TRIANGLE_STRIP, 0, 4);
					} else if (visible) {
						context.clear(context.COLOR_BUFFER_BIT);
						sparkCanvas.style.display = "none";
						visible = false;
					}
				} catch { disable(); }
			},
		};
	} catch {
		disable();
		return null;
	}
}

const sparkEffect = createSparkEffect();

let currentIntensity = 0;

// Burst mode: randomly toggle sparks on/off
let bursting = true;
let burstUntil = performance.now() + 200 + Math.random() * 400;

function scheduleBurst() {
	bursting = !bursting;
	// On: 500-2000ms burst, Off: 3-10s pause
	const duration = bursting
		? 500 + Math.random() * 1500
		: 3000 + Math.random() * 7000;
	burstUntil = performance.now() + duration;
}

const MAX_ROTATION = 32;
const SPRING = 0.08;
const DAMPING = 0.85;

let targetRotateX = 0;
let targetRotateY = 0;
let currentRotateX = 0;
let currentRotateY = 0;
let velocityX = 0;
let velocityY = 0;

const rpc = Electroview.defineRPC<any>({
	maxRequestTime: 5000,
	handlers: {
		requests: {},
		messages: {
			cursorMove: ({ screenX, screenY, winX, winY, winW, winH }) => {
				const centerX = winX + winW / 2;
				const centerY = winY + winH / 2;

				const normalizedX = (screenX - centerX) / (winW / 2);
				const normalizedY = (screenY - centerY) / (winH / 2);

				const clampedX = Math.max(-1, Math.min(1, normalizedX));
				const clampedY = Math.max(-1, Math.min(1, normalizedY));

				targetRotateX = -clampedY * MAX_ROTATION;
				targetRotateY = clampedX * MAX_ROTATION;
			},
		},
	},
});

const electrobun = new Electrobun.Electroview({ rpc });

// Click detection (distinguish from drag using screen coordinates)
let downX = 0;
let downY = 0;
const scene = document.getElementById("scene")!;
scene.addEventListener("mousedown", (e) => { downX = e.screenX; downY = e.screenY; });
scene.addEventListener("mouseup", (e) => {
	const dx = e.screenX - downX;
	const dy = e.screenY - downY;
	if (dx * dx + dy * dy < 25) {
		(rpc as any).send.bunnyClicked();
	}
});

function animate() {
	const forceX = (targetRotateX - currentRotateX) * SPRING;
	const forceY = (targetRotateY - currentRotateY) * SPRING;

	velocityX = (velocityX + forceX) * DAMPING;
	velocityY = (velocityY + forceY) * DAMPING;

	currentRotateX += velocityX;
	currentRotateY += velocityY;

	bunny.style.transform =
		`rotateX(${currentRotateX}deg) rotateY(${currentRotateY}deg)`;

	// Drive electric spark shader with random bursts
	if (performance.now() >= burstUntil) {
		scheduleBurst();
	}
	const targetIntensity = bursting ? 1.0 : 0.0;
	currentIntensity += (targetIntensity - currentIntensity) * 0.12;

	sparkEffect?.draw(performance.now(), currentIntensity);

	requestAnimationFrame(animate);
}

animate();
