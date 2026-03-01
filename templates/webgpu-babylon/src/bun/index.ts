import { GpuWindow, Screen, babylon, webgpu } from "electrobun/bun";
import { readFileSync } from "fs";
import { resolve } from "path";
import { inflateSync } from "zlib";

function ensureAnimationFrame() {
	if (!(globalThis as any).requestAnimationFrame) {
		(globalThis as any).requestAnimationFrame = (cb: (t: number) => void) =>
			setTimeout(() => cb(performance.now()), 16) as any;
		(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
	}
}

function createCanvasShim(win: GpuWindow) {
	const size = win.getSize();
	return {
		width: size.width,
		height: size.height,
		clientWidth: size.width,
		clientHeight: size.height,
		style: {},
		getContext: (type: string) => {
			if (type !== "webgpu") return null;
			const ctx = webgpu.createContext(win);
			return ctx.context;
		},
		getBoundingClientRect: () => {
			const current = win.getSize();
			return {
				left: 0,
				top: 0,
				width: current.width,
				height: current.height,
			};
		},
		addEventListener: () => {},
		removeEventListener: () => {},
		setAttribute: () => {},
	};
}

function decodePngRGBA(data: Uint8Array) {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const readU32 = (offset: number) => view.getUint32(offset, false);

	if (readU32(0) !== 0x89504e47) {
		throw new Error("Invalid PNG header");
	}

	let offset = 8;
	let width = 0;
	let height = 0;
	let bitDepth = 0;
	let colorType = 0;
	const idat: Uint8Array[] = [];

	while (offset < data.length) {
		const length = readU32(offset);
		const type = String.fromCharCode(
			data[offset + 4]!,
			data[offset + 5]!,
			data[offset + 6]!,
			data[offset + 7]!,
		);
		const chunkStart = offset + 8;
		const chunkEnd = chunkStart + length;

		if (type === "IHDR") {
			width = readU32(chunkStart);
			height = readU32(chunkStart + 4);
			bitDepth = data[chunkStart + 8]!;
			colorType = data[chunkStart + 9]!;
		} else if (type === "IDAT") {
			idat.push(data.subarray(chunkStart, chunkEnd));
		} else if (type === "IEND") {
			break;
		}

		offset = chunkEnd + 4;
	}

	if (bitDepth !== 8 || colorType !== 6) {
		throw new Error("PNG must be RGBA 8-bit");
	}

	const compressed = new Uint8Array(idat.reduce((sum, chunk) => sum + chunk.length, 0));
	let cursor = 0;
	for (const chunk of idat) {
		compressed.set(chunk, cursor);
		cursor += chunk.length;
	}

	const inflated = inflateSync(compressed);
	const bpp = 4;
	const stride = width * bpp;
	const output = new Uint8Array(height * stride);
	let inOffset = 0;
	let outOffset = 0;

	for (let y = 0; y < height; y += 1) {
		const filter = inflated[inOffset]!;
		inOffset += 1;
		const row = inflated.subarray(inOffset, inOffset + stride);
		inOffset += stride;

		for (let x = 0; x < stride; x += 1) {
			const left = x >= bpp ? output[outOffset + x - bpp]! : 0;
			const up = y > 0 ? output[outOffset - stride + x]! : 0;
			const upLeft = y > 0 && x >= bpp ? output[outOffset - stride + x - bpp]! : 0;
			let val = row[x]!;
			if (filter === 1) val = (val + left) & 0xff;
			else if (filter === 2) val = (val + up) & 0xff;
			else if (filter === 3) val = (val + Math.floor((left + up) / 2)) & 0xff;
			else if (filter === 4) {
				const p = left + up - upLeft;
				const pa = Math.abs(p - left);
				const pb = Math.abs(p - up);
				const pc = Math.abs(p - upLeft);
				const paeth = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
				val = (val + paeth) & 0xff;
			}
			output[outOffset + x] = val;
		}
		outOffset += stride;
	}

	return { width, height, data: output };
}

const display = Screen.getPrimaryDisplay();
const workArea = display.workArea;

const win = new GpuWindow({
	title: "WebGPU Babylon Platformer",
	frame: { width: 960, height: 540, x: workArea.x + 120, y: workArea.y + 80 },
	titleBarStyle: "default",
	transparent: false,
});
win.focus();

console.log("Controls: Left/Right arrows to move, Space to jump.");

ensureAnimationFrame();
webgpu.install();

const canvas = createCanvasShim(win);
const engine = new babylon.WebGPUEngine(canvas as any, { antialias: false });
await engine.initAsync();

const scene = new babylon.Scene(engine);
scene.clearColor = new babylon.Color4(0.12, 0.12, 0.15, 1);

const light = new babylon.HemisphericLight(
	"light",
	new babylon.Vector3(0.4, 1, 0.6),
	scene,
);
light.intensity = 0.9;

const debugBox = babylon.MeshBuilder.CreateBox(
	"debugBox",
	{ size: 0.8 },
	scene,
);
debugBox.position = new babylon.Vector3(0, 2.8, 0);
const debugMat = new babylon.StandardMaterial("debugMat", scene);
debugMat.emissiveColor = new babylon.Color3(0.95, 0.2, 0.2);
debugBox.material = debugMat;

const camera = new babylon.FreeCamera(
	"camera",
	new babylon.Vector3(0, 3.2, 10),
	scene,
);
camera.inputs.clear();
scene.activeCamera = camera;

let lastSize = win.getSize();

const platformMaterial = new babylon.StandardMaterial("platformMat", scene);
platformMaterial.diffuseColor = new babylon.Color3(0.18, 0.2, 0.24);
platformMaterial.specularColor = babylon.Color3.Black();

const platformData = [
	{ x: 0, y: 0, w: 24, h: 0.8 },
	{ x: 6, y: 2.2, w: 4, h: 0.5 },
	{ x: -6, y: 3.5, w: 3.5, h: 0.5 },
	{ x: 12, y: 4.5, w: 4, h: 0.5 },
	{ x: -12, y: 5, w: 5, h: 0.6 },
];

const platforms = platformData.map((p) => {
	const mesh = babylon.MeshBuilder.CreateBox(
		`platform-${p.x}-${p.y}`,
		{ width: p.w, height: p.h, depth: 1 },
		scene,
	);
	mesh.position = new babylon.Vector3(p.x, p.y - p.h / 2, 0);
	mesh.material = platformMaterial;
	return { ...p, mesh };
});

const bunnyPath = resolve(import.meta.dir, "..", "assets", "bunny.png");
let bunnyTexture: babylon.RawTexture | null = null;
let bunnySize = { width: 1, height: 1 };
try {
	const bytes = readFileSync(bunnyPath);
	const decoded = decodePngRGBA(new Uint8Array(bytes));
	bunnySize = { width: decoded.width, height: decoded.height };
	bunnyTexture = new babylon.RawTexture(
		decoded.data,
		decoded.width,
		decoded.height,
		babylon.Engine.TEXTUREFORMAT_RGBA,
		scene,
		false,
		false,
		babylon.Texture.NEAREST_SAMPLINGMODE,
		babylon.Engine.TEXTURETYPE_UNSIGNED_INT,
	);
	bunnyTexture.wrapU = babylon.Texture.CLAMP_ADDRESSMODE;
	bunnyTexture.wrapV = babylon.Texture.CLAMP_ADDRESSMODE;
	bunnyTexture.vScale = -1;
	bunnyTexture.vOffset = 1;
} catch (err) {
	console.warn("Failed to load bunny texture:", err);
}

const playerMaterial = new babylon.StandardMaterial("playerMat", scene);
playerMaterial.diffuseColor = new babylon.Color3(1, 1, 1);
playerMaterial.specularColor = babylon.Color3.Black();
playerMaterial.emissiveColor = new babylon.Color3(1, 1, 1);
if (bunnyTexture) {
	playerMaterial.diffuseTexture = bunnyTexture;
	playerMaterial.opacityTexture = bunnyTexture;
	playerMaterial.useAlphaFromDiffuseTexture = true;
}

const bunnyAspect = bunnyTexture ? bunnySize.height / bunnySize.width : 1.0;

const player = babylon.MeshBuilder.CreatePlane(
	"player",
	{ width: 1.0, height: 1.0 * bunnyAspect },
	scene,
);
player.position = new babylon.Vector3(-2, 2.5, 0);
player.material = playerMaterial;
(player.material as babylon.StandardMaterial).backFaceCulling = false;

const carrotMaterial = new babylon.StandardMaterial("carrotMat", scene);
carrotMaterial.emissiveColor = new babylon.Color3(0.9, 0.35, 0.05);
carrotMaterial.diffuseColor = new babylon.Color3(0.95, 0.42, 0.08);
carrotMaterial.specularColor = new babylon.Color3(0.2, 0.2, 0.2);

const carrotLeafMaterial = new babylon.StandardMaterial("carrotLeafMat", scene);
carrotLeafMaterial.diffuseColor = new babylon.Color3(0.2, 0.6, 0.3);
carrotLeafMaterial.emissiveColor = new babylon.Color3(0.12, 0.4, 0.2);
carrotLeafMaterial.specularColor = babylon.Color3.Black();

const carrots: babylon.TransformNode[] = [];
const maxCarrots = 3;
let carrotCounter = 0;

function createCarrotMesh(id: number) {
	const root = new babylon.TransformNode(`carrot-${id}`, scene);
	const body = babylon.MeshBuilder.CreateCylinder(
		`carrot-body-${id}`,
		{ height: 0.7, diameterTop: 0.02, diameterBottom: 0.2, tessellation: 12 },
		scene,
	);
	body.material = carrotMaterial;
	body.rotation.z = Math.PI;
	body.parent = root;

	const leaves = babylon.MeshBuilder.CreateCylinder(
		`carrot-leaves-${id}`,
		{ height: 0.22, diameterTop: 0.12, diameterBottom: 0.02, tessellation: 8 },
		scene,
	);
	leaves.material = carrotLeafMaterial;
	leaves.position.y = 0.36;
	leaves.parent = root;

	return root;
}

function spawnCarrot() {
	const carrot = createCarrotMesh(carrotCounter++);
	carrot.position = new babylon.Vector3(
		-10 + Math.random() * 20,
		2 + Math.random() * 4,
		0,
	);
	carrot.rotation.y = Math.random() * Math.PI * 2;
	carrots.push(carrot);
}

while (carrots.length < maxCarrots) {
	spawnCarrot();
}

const digitSegments = [
	[1, 1, 1, 1, 1, 1, 0], // 0
	[0, 1, 1, 0, 0, 0, 0], // 1
	[1, 1, 0, 1, 1, 0, 1], // 2
	[1, 1, 1, 1, 0, 0, 1], // 3
	[0, 1, 1, 0, 0, 1, 1], // 4
	[1, 0, 1, 1, 0, 1, 1], // 5
	[1, 0, 1, 1, 1, 1, 1], // 6
	[1, 1, 1, 0, 0, 0, 0], // 7
	[1, 1, 1, 1, 1, 1, 1], // 8
	[1, 1, 1, 1, 0, 1, 1], // 9
];

const scoreRoot = new babylon.TransformNode("scoreRoot", scene);
const scoreMaterial = new babylon.StandardMaterial("scoreMat", scene);
scoreMaterial.emissiveColor = new babylon.Color3(1, 1, 1);
scoreMaterial.diffuseColor = new babylon.Color3(1, 1, 1);
scoreMaterial.specularColor = babylon.Color3.Black();

function createSegment(name: string, width: number, height: number) {
	const seg = babylon.MeshBuilder.CreateBox(
		name,
		{ width, height, depth: 0.06 },
		scene,
	);
	seg.material = scoreMaterial;
	return seg;
}

function createDigitMeshes(index: number) {
	const root = new babylon.TransformNode(`scoreDigit-${index}`, scene);
	root.parent = scoreRoot;
	const w = 0.38;
	const h = 0.08;
	const x = 0.22;
	const y = 0.18;

	const segments = [
		createSegment(`segA-${index}`, w, h),
		createSegment(`segB-${index}`, h, 0.24),
		createSegment(`segC-${index}`, h, 0.24),
		createSegment(`segD-${index}`, w, h),
		createSegment(`segE-${index}`, h, 0.24),
		createSegment(`segF-${index}`, h, 0.24),
		createSegment(`segG-${index}`, w, h),
	];

	segments[0]!.position = new babylon.Vector3(0, y * 2, 0);
	segments[1]!.position = new babylon.Vector3(x, y, 0);
	segments[2]!.position = new babylon.Vector3(x, -y, 0);
	segments[3]!.position = new babylon.Vector3(0, -y * 2, 0);
	segments[4]!.position = new babylon.Vector3(-x, -y, 0);
	segments[5]!.position = new babylon.Vector3(-x, y, 0);
	segments[6]!.position = new babylon.Vector3(0, 0, 0);

	segments.forEach((seg) => {
		seg.parent = root;
	});

	return { root, segments };
}

const scoreDigits = [createDigitMeshes(0), createDigitMeshes(1), createDigitMeshes(2)];
scoreDigits[0]!.root.position.x = -0.6;
scoreDigits[1]!.root.position.x = 0;
scoreDigits[2]!.root.position.x = 0.6;

let score = 0;
function updateScore() {
	const str = String(score);
	const padded = str.padStart(3, " ");
	padded.split("").forEach((ch, idx) => {
		const digit = ch === " " ? -1 : Number(ch);
		const segmentMask = digit >= 0 ? digitSegments[digit] : [0, 0, 0, 0, 0, 0, 0];
		scoreDigits[idx]!.segments.forEach((seg, segIndex) => {
			seg.isVisible = segmentMask[segIndex] === 1;
		});
	});
}
updateScore();

const playerState = {
	vx: 0,
	vy: 0,
	grounded: false,
};

const hopState = {
	cooldown: 0,
};

const inputState = {
	left: false,
	right: false,
	jumpQueued: false,
};

win.on("keyDown", (event: any) => {
	const { keyCode, isRepeat } = event.data ?? {};
	if (keyCode === 123) inputState.right = true;
	if (keyCode === 124) inputState.left = true;
	if (keyCode === 49 && !isRepeat) inputState.jumpQueued = true;
});

win.on("keyUp", (event: any) => {
	const { keyCode } = event.data ?? {};
	if (keyCode === 123) inputState.right = false;
	if (keyCode === 124) inputState.left = false;
});

const playerHalf = {
	x: 0.5,
	y: 0.5 * bunnyAspect,
};

function resolveCollisions(position: babylon.Vector3, vx: number, vy: number) {
	let grounded = false;

	for (const platform of platforms) {
		const halfW = platform.w / 2;
		const halfH = platform.h / 2;
		const centerX = platform.mesh.position.x;
		const centerY = platform.mesh.position.y;
		const dx = position.x - centerX;
		const dy = position.y - centerY;
		const overlapX = halfW + playerHalf.x - Math.abs(dx);
		const overlapY = halfH + playerHalf.y - Math.abs(dy);

		if (overlapX > 0 && overlapY > 0) {
			if (overlapX < overlapY) {
				if (dx > 0) {
					position.x = centerX + halfW + playerHalf.x;
				} else {
					position.x = centerX - halfW - playerHalf.x;
				}
				vx = 0;
			} else {
				if (dy > 0) {
					position.y = centerY + halfH + playerHalf.y;
					vy = 0;
					grounded = true;
				} else {
					position.y = centerY - halfH - playerHalf.y;
					vy = 0;
				}
			}
		}
	}

	return { vx, vy, grounded };
}

engine.runRenderLoop(() => {
	const now = performance.now();
	const delta = engine.getDeltaTime() / 1000;

	const moveSpeed = 6.5;
	const gravity = -18;
	const jumpVelocity = 9.5;
	const hopVelocity = jumpVelocity * 0.5;
	const hopInterval = 0.45;

	playerState.vx = 0;
	if (inputState.left) playerState.vx = -moveSpeed;
	if (inputState.right) playerState.vx = moveSpeed;

	hopState.cooldown = Math.max(0, hopState.cooldown - delta);

	if (inputState.jumpQueued && playerState.grounded) {
		playerState.vy = jumpVelocity;
		playerState.grounded = false;
		inputState.jumpQueued = false;
	}

	const movingHorizontally = inputState.left || inputState.right;
	if (movingHorizontally && playerState.grounded && hopState.cooldown === 0) {
		playerState.vy = hopVelocity;
		playerState.grounded = false;
		hopState.cooldown = hopInterval;
	}

	playerState.vy += gravity * delta;

	const position = player.position.clone();
	position.x += playerState.vx * delta;
	position.y += playerState.vy * delta;

	let resolved = resolveCollisions(position, playerState.vx, playerState.vy);
	playerState.vx = resolved.vx;
	playerState.vy = resolved.vy;
	playerState.grounded = resolved.grounded;

	player.position = position;
	if (player.position.y < -6) {
		player.position = new babylon.Vector3(-2, 3, 0);
		playerState.vx = 0;
		playerState.vy = 0;
		playerState.grounded = false;
	}

	for (let i = carrots.length - 1; i >= 0; i -= 1) {
		const carrot = carrots[i]!;
		carrot.position.y += Math.sin(now * 0.002 + i) * 0.002;
		carrot.rotation.y += delta * 0.8;
		const dx = carrot.position.x - player.position.x;
		const dy = carrot.position.y - player.position.y;
		if (Math.hypot(dx, dy) < 0.6) {
			carrot.dispose();
			carrots.splice(i, 1);
			score += 1;
			updateScore();
		}
	}
	while (carrots.length < maxCarrots) {
		spawnCarrot();
	}

	scoreRoot.position.x = camera.position.x - 3.6;
	scoreRoot.position.y = camera.position.y + 2;
	scoreRoot.position.z = camera.position.z - 2.5;
	scoreRoot.lookAt(camera.position);
	camera.position.x = player.position.x;
	camera.position.y = 3.2;
	camera.position.z = 10;
	camera.setTarget(new babylon.Vector3(player.position.x, 2.5, 0));

	const size = win.getSize();
	if (size.width !== lastSize.width || size.height !== lastSize.height) {
		lastSize = size;
		canvas.width = size.width;
		canvas.height = size.height;
		canvas.clientWidth = size.width;
		canvas.clientHeight = size.height;
		engine.resize();
	}

	scene.render();
});

engine.onEndFrameObservable.addOnce(() => {
	console.log("[webgpu-babylon] first frame rendered", {
		meshes: scene.meshes.length,
		drawCalls: (engine as any)._drawCallsCurrentFrame,
	});
});
