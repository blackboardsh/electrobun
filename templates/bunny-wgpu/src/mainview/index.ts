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

const gl = sparkCanvas.getContext("webgl", {
	alpha: true,
	premultipliedAlpha: true,
	antialias: false,
})!;

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

function compileShader(src: string, type: number) {
	const s = gl.createShader(type)!;
	gl.shaderSource(s, src);
	gl.compileShader(s);
	return s;
}

const vs = compileShader(vsSource, gl.VERTEX_SHADER);
const fs = compileShader(fsSource, gl.FRAGMENT_SHADER);
const prog = gl.createProgram()!;
gl.attachShader(prog, vs);
gl.attachShader(prog, fs);
gl.linkProgram(prog);
gl.useProgram(prog);

// Fullscreen quad
const buf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, buf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
const aPos = gl.getAttribLocation(prog, "a_pos");
gl.enableVertexAttribArray(aPos);
gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

const uTime = gl.getUniformLocation(prog, "u_time");
const uResolution = gl.getUniformLocation(prog, "u_resolution");
const uIntensity = gl.getUniformLocation(prog, "u_intensity");

gl.enable(gl.BLEND);
gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

function resizeCanvas() {
	const rect = bunny.getBoundingClientRect();
	sparkCanvas.width = Math.round(rect.width * devicePixelRatio);
	sparkCanvas.height = Math.round(rect.height * devicePixelRatio);
	gl.viewport(0, 0, sparkCanvas.width, sparkCanvas.height);
}

resizeCanvas();
new ResizeObserver(resizeCanvas).observe(bunny);

let currentIntensity = 0;
let shaderActive = false;

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

	if (currentIntensity > 0.001) {
		if (!shaderActive) {
			sparkCanvas.style.display = "";
			shaderActive = true;
		}
		gl.uniform1f(uTime, performance.now() / 1000);
		gl.uniform2f(uResolution, sparkCanvas.width, sparkCanvas.height);
		gl.uniform1f(uIntensity, currentIntensity);
		gl.clear(gl.COLOR_BUFFER_BIT);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
	} else if (shaderActive) {
		gl.clear(gl.COLOR_BUFFER_BIT);
		sparkCanvas.style.display = "none";
		shaderActive = false;
	}

	requestAnimationFrame(animate);
}

animate();
