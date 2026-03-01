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

const ledgeMaterial = new babylon.StandardMaterial("ledgeMat", scene);
ledgeMaterial.diffuseColor = new babylon.Color3(0.9, 0.45, 0.6);
ledgeMaterial.emissiveColor = new babylon.Color3(0.9, 0.35, 0.55);
ledgeMaterial.specularColor = babylon.Color3.Black();

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

const ledge = babylon.MeshBuilder.CreateBox(
	"pink-ledge",
	{ width: 1.6, height: 0.4, depth: 1 },
	scene,
);
ledge.position = new babylon.Vector3(0, 2.8, 0);
ledge.material = ledgeMaterial;
platforms.push({ x: 0, y: 2.8, w: 1.6, h: 0.4, mesh: ledge, isLedge: true });

const ledgeState = {
	baseY: 2.8,
	offset: 0,
	velocity: 0,
	wasOn: false,
};

const hungryState = {
	cooldownUntil: 0,
};

const winState = {
	active: false,
	countdown: 0,
	untilTick: 0,
};

const messageWidth = 256;
const messageHeight = 64;
const messageData = new Uint8Array(messageWidth * messageHeight * 4);
const messageTexture = new babylon.RawTexture(
	messageData,
	messageWidth,
	messageHeight,
	babylon.Engine.TEXTUREFORMAT_RGBA,
	scene,
	false,
	false,
	babylon.Texture.NEAREST_SAMPLINGMODE,
	babylon.Engine.TEXTURETYPE_UNSIGNED_INT,
);
const messageMaterial = new babylon.StandardMaterial("messageMat", scene);
messageMaterial.diffuseTexture = messageTexture;
messageMaterial.emissiveTexture = messageTexture;
messageMaterial.emissiveColor = new babylon.Color3(1, 1, 1);
messageMaterial.opacityTexture = messageTexture;
messageMaterial.useAlphaFromDiffuseTexture = true;
messageMaterial.specularColor = babylon.Color3.Black();
messageMaterial.disableLighting = true;
messageMaterial.backFaceCulling = false;
messageTexture.hasAlpha = true;

const messageRoot = new babylon.TransformNode("messageRoot", scene);
messageRoot.scaling.x = -1;

const messagePlane = babylon.MeshBuilder.CreatePlane(
	"messagePlane",
	{ width: 3.6, height: 0.9 },
	scene,
);
messagePlane.material = messageMaterial;
messagePlane.isVisible = false;
messagePlane.billboardMode = babylon.Mesh.BILLBOARDMODE_ALL;
messagePlane.renderingGroupId = 2;
messagePlane.isPickable = false;
messagePlane.parent = messageRoot;

const messageBackdrop = babylon.MeshBuilder.CreatePlane(
	"messageBackdrop",
	{ width: 3.9, height: 1.05 },
	scene,
);
const messageBackdropMat = new babylon.StandardMaterial("messageBackdropMat", scene);
messageBackdropMat.emissiveColor = new babylon.Color3(0, 0, 0);
messageBackdropMat.diffuseColor = new babylon.Color3(0, 0, 0);
messageBackdropMat.alpha = 0.35;
messageBackdropMat.disableLighting = true;
messageBackdrop.material = messageBackdropMat;
messageBackdrop.isVisible = false;
messageBackdrop.renderingGroupId = 1;
messageBackdrop.parent = messageRoot;

const FONT: Record<string, string[]> = {
	H: ["10001", "10001", "11111", "10001", "10001", "10001", "10001"],
	U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
	N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
	G: ["01110", "10001", "10000", "10111", "10001", "10001", "01110"],
	R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
	Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
	F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
	E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
	D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
	S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
	L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
	P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
	"!": ["00100", "00100", "00100", "00100", "00100", "00000", "00100"],
	"0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
	"1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
	"2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
	"3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
	"4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
	"5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
	"6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
	"7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
	"8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
	"9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
	" ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};

function clearMessage() {
	messageData.fill(0);
}

function drawMessage(text: string) {
	clearMessage();
	const scale = 4;
	const glyphW = 5;
	const glyphH = 7;
	const spacing = 1;
	const textUpper = text.toUpperCase();
	const totalWidth =
		textUpper.length * (glyphW + spacing) - spacing;
	const startX = Math.floor((messageWidth / scale - totalWidth) / 2);
	const startY = Math.floor((messageHeight / scale - glyphH) / 2);

	textUpper.split("").forEach((ch, idx) => {
		const glyph = FONT[ch] ?? FONT[" "];
		const baseX = startX + idx * (glyphW + spacing);
		for (let y = 0; y < glyphH; y += 1) {
			for (let x = 0; x < glyphW; x += 1) {
				if (glyph[y]![x] !== "1") continue;
				const px = baseX + x;
				const py = startY + y;
				for (let sy = 0; sy < scale; sy += 1) {
					for (let sx = 0; sx < scale; sx += 1) {
						const dx = (py * scale + sy) * messageWidth + (px * scale + sx);
						if (dx < 0 || dx >= messageWidth * messageHeight) continue;
						const di = dx * 4;
						messageData[di] = 255;
						messageData[di + 1] = 255;
						messageData[di + 2] = 255;
						messageData[di + 3] = 255;
					}
				}
			}
		}
	});
	messageTexture.update(messageData);
}

const messageState = { text: "", until: 0 };
function setMessage(text: string, durationMs = 0) {
	messageState.text = text;
	messageState.until = durationMs ? performance.now() + durationMs : 0;
	drawMessage(text);
	messagePlane.isVisible = false;
	messageBackdrop.isVisible = text.length > 0;
	setMeshMessage(text);
}

const messageMeshes: babylon.AbstractMesh[] = [];
const messageMeshMaterial = new babylon.StandardMaterial("messageMeshMat", scene);
messageMeshMaterial.emissiveColor = new babylon.Color3(1, 1, 1);
messageMeshMaterial.diffuseColor = new babylon.Color3(1, 1, 1);
messageMeshMaterial.specularColor = babylon.Color3.Black();
messageMeshMaterial.disableLighting = true;

function clearMessageMeshes() {
	for (const mesh of messageMeshes) {
		mesh.dispose();
	}
	messageMeshes.length = 0;
}

function setMeshMessage(text: string) {
	clearMessageMeshes();
	if (!text) return;
	const upper = text.toUpperCase();
	const scale = 0.035;
	const glyphW = 5;
	const glyphH = 7;
	const spacing = 1;
	const totalWidth = upper.length * (glyphW + spacing) - spacing;
	const startX = (-totalWidth * scale) / 2;
	const startY = (glyphH * scale) / 2;

	for (let i = 0; i < upper.length; i += 1) {
		const glyph = FONT[upper[i]!] ?? FONT[" "];
		const baseX = startX + i * (glyphW + spacing) * scale;
		for (let y = 0; y < glyphH; y += 1) {
			for (let x = 0; x < glyphW; x += 1) {
				if (glyph[y]![x] !== "1") continue;
				const box = babylon.MeshBuilder.CreateBox(
					`msg-${upper[i]}-${x}-${y}`,
					{ width: scale, height: scale, depth: 0.03 },
					scene,
				);
				box.material = messageMeshMaterial;
				box.position.x = baseX + x * scale;
				box.position.y = startY - y * scale;
				box.position.z = 0.2;
				box.parent = messageRoot;
				box.isPickable = false;
				box.renderingGroupId = 2;
				messageMeshes.push(box);
			}
		}
	}
}

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
player.scaling.x = 1;

let facing = 1;

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
const targetCarrots = 12;
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
const scaleState = { current: 1, target: 1 };
const scaleConfig = {
	max: 3.2,
	perCarrot: 0.15,
};
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

function showCountdownMessage(value: number) {
	setMessage(`SLEEP ${value}`, 1100);
}

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

function resetGame() {
	score = 0;
	scaleState.current = 1;
	scaleState.target = 1;
	updateScore();
	player.position = new babylon.Vector3(-2, 2.5, 0);
	playerState.vx = 0;
	playerState.vy = 0;
	playerState.grounded = false;
	ledgeState.offset = 0;
	ledgeState.velocity = 0;
	ledgeState.wasOn = false;
	winState.active = false;
	winState.countdown = 0;
	winState.untilTick = 0;
	carrots.forEach((carrot) => carrot.dispose());
	carrots.length = 0;
	while (carrots.length < maxCarrots) {
		spawnCarrot();
	}
	setMessage("", 0);
}

function resolveCollisions(
	position: babylon.Vector3,
	vx: number,
	vy: number,
	half: { x: number; y: number },
) {
	let grounded = false;
	let landedOnLedge = false;

	for (const platform of platforms) {
		const halfW = platform.w / 2;
		const halfH = platform.h / 2;
		const centerX = platform.mesh.position.x;
		const centerY = platform.mesh.position.y;
		const dx = position.x - centerX;
		const dy = position.y - centerY;
		const overlapX = halfW + half.x - Math.abs(dx);
		const overlapY = halfH + half.y - Math.abs(dy);

		if (overlapX > 0 && overlapY > 0) {
			if (overlapX < overlapY) {
				if (dx > 0) {
					position.x = centerX + halfW + half.x;
				} else {
					position.x = centerX - halfW - half.x;
				}
				vx = 0;
			} else {
				if (dy > 0) {
					position.y = centerY + halfH + half.y;
					vy = 0;
					grounded = true;
					if ((platform as any).isLedge) {
						landedOnLedge = true;
					}
				} else {
					position.y = centerY - halfH - half.y;
					vy = 0;
				}
			}
		}
	}

	return { vx, vy, grounded, landedOnLedge };
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
	if (inputState.left) facing = 1;
	if (inputState.right) facing = -1;
	if (movingHorizontally && playerState.grounded && hopState.cooldown === 0) {
		playerState.vy = hopVelocity;
		playerState.grounded = false;
		hopState.cooldown = hopInterval;
	}

	playerState.vy += gravity * delta;

	const position = player.position.clone();
	position.x += playerState.vx * delta;
	position.y += playerState.vy * delta;

	const collisionScale = 1 + (scaleState.current - 1) * 0.6;
	const scaledHalf = {
		x: playerHalf.x * collisionScale,
		y: playerHalf.y * collisionScale,
	};
	let resolved = resolveCollisions(position, playerState.vx, playerState.vy, scaledHalf);
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
	const flipSpeed = 10;
	const currentScale = player.scaling.x;
	const targetScale = facing;
	player.scaling.x = currentScale + (targetScale - currentScale) * Math.min(1, flipSpeed * delta);

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
			scaleState.target = Math.min(scaleConfig.max, scaleState.target + scaleConfig.perCarrot);
			updateScore();
		}
	}
	while (carrots.length < maxCarrots) {
		spawnCarrot();
	}

	scoreRoot.position.x = camera.position.x - 3.6;
	scoreRoot.position.y = camera.position.y + 2;
	scoreRoot.position.z = camera.position.z - 2.5;
	const landedNow = resolved.landedOnLedge && !ledgeState.wasOn;
	if (landedNow && !winState.active) {
		if (score >= targetCarrots) {
			winState.active = true;
			winState.countdown = 5;
			winState.untilTick = now + 1000;
			setMessage("FED", 900);
			ledgeState.velocity = -2.4;
		} else {
			ledgeState.velocity = Math.min(-0.2, -0.6 * scaleState.current);
		}
	}
	ledgeState.wasOn = resolved.landedOnLedge;
	const maxDrop = winState.active ? 2.0 : 0.25 * scaleState.current;
	if (winState.active) {
		ledgeState.velocity += -4 * delta;
		ledgeState.offset += ledgeState.velocity * delta;
		if (ledgeState.offset < -maxDrop) {
			ledgeState.offset = -maxDrop;
			ledgeState.velocity = 0;
		}
	} else {
		const spring = 12;
		const damping = 6;
		ledgeState.velocity += (-ledgeState.offset * spring - ledgeState.velocity * damping) * delta;
		ledgeState.offset += ledgeState.velocity * delta;
		if (ledgeState.offset < -maxDrop) {
			ledgeState.offset = -maxDrop;
			ledgeState.velocity = Math.max(ledgeState.velocity, 0);
			if (score < targetCarrots && now > hungryState.cooldownUntil) {
				setMessage("HUNGRY!", 1200);
				hungryState.cooldownUntil = now + 1800;
			}
		}
	}
	ledge.position.y = ledgeState.baseY + ledgeState.offset;

	if (winState.active && now >= winState.untilTick) {
		winState.countdown -= 1;
		winState.untilTick = now + 1000;
		if (winState.countdown > 0) {
			showCountdownMessage(winState.countdown);
		} else {
			resetGame();
		}
	}

	scoreRoot.lookAt(camera.position);
	camera.position.x = player.position.x;
	camera.position.y = 3.2;
	camera.position.z = 10;
	camera.setTarget(new babylon.Vector3(player.position.x, 2.5, 0));

	if (messagePlane.isVisible || messageBackdrop.isVisible) {
		if (messageState.until && now > messageState.until) {
			setMessage("", 0);
		}
	}
	if (messageMeshes.length > 0) {
		messageRoot.position.x = player.position.x;
		messageRoot.position.y = player.position.y + 0.8 + scaleState.current * 0.1;
		messageRoot.position.z = 0;
	}

	const scaleSpeed = 3;
	scaleState.current += (scaleState.target - scaleState.current) * Math.min(1, scaleSpeed * delta);
	player.scaling.x = facing * scaleState.current;
	player.scaling.y = scaleState.current;

	const size = win.getSize();
	if (size.width !== lastSize.width || size.height !== lastSize.height) {
		lastSize = size;
		canvas.width = size.width;
		canvas.height = size.height;
		canvas.clientWidth = size.width;
		canvas.clientHeight = size.height;
		engine.resize();
	}

	if (size.width > 0 && size.height > 0 && engine.getRenderWidth() > 0 && engine.getRenderHeight() > 0) {
		if (messageState.text && messageMeshes.length === 0) {
			setMeshMessage(messageState.text);
		}
		scene.render();
	}
});

engine.onEndFrameObservable.addOnce(() => {
	console.log("[webgpu-babylon] first frame rendered", {
		meshes: scene.meshes.length,
		drawCalls: (engine as any)._drawCallsCurrentFrame,
	});
});
