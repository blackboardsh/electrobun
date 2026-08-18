import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

type EnvKey =
	| "R2_ACCOUNT_ID"
	| "R2_ACCESS_KEY_ID"
	| "R2_SECRET_ACCESS_KEY";

export const KITCHEN_ARTIFACT_BUCKET = "electrobun-artifacts";
export const KITCHEN_ARTIFACT_PREFIX = "kitchen";
export const KITCHEN_ARTIFACT_PUBLIC_BASE_URL =
	"https://electrobun-artifacts.blackboard.sh/kitchen";

const KITCHEN_ARTIFACT_NAME =
	/^(?:(canary|stable)-)?(macos|linux|win)-(arm64|x64)-(.+)$/;

const isStableUpdateArtifact = (filename: string): boolean =>
	filename.endsWith("-update.json") ||
	filename.endsWith(".tar.zst") ||
	/-[a-z0-9]+\.patch$/.test(filename);

const requiredEnv = (key: EnvKey): string => {
	const value = process.env[key];
	if (!value) {
		console.error(`Missing required environment variable: ${key}`);
		process.exit(1);
	}
	return value;
};

async function* walk(dir: string): AsyncGenerator<string> {
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* walk(fullPath);
		} else if (entry.isFile()) {
			yield fullPath;
		}
	}
}

export const kitchenArtifactKey = (filePath: string): string => {
	const filename = basename(filePath);
	const match = KITCHEN_ARTIFACT_NAME.exec(filename);
	if (!match || (match[1] === "stable" && !isStableUpdateArtifact(filename))) {
		throw new Error(`Unexpected Kitchen artifact filename: ${filename}`);
	}
	return `${KITCHEN_ARTIFACT_PREFIX}/${filename}`;
};

export const isKitchenUpdateManifest = (key: string): boolean =>
	key.endsWith("-update.json");

async function main() {
	const artifactsDir = process.argv[2];
	const dryRun = process.argv.includes("--dry-run");
	if (!artifactsDir) {
		console.error(
			"Usage: hutch scripts/upload-kitchen-artifacts.ts <artifactsDir> [--dry-run]",
		);
		process.exit(1);
	}

	// Validate directory exists
	try {
		const stats = await stat(artifactsDir);
		if (!stats.isDirectory()) {
			console.error(`Provided path is not a directory: ${artifactsDir}`);
			process.exit(1);
		}
	} catch (error) {
		console.error(
			`Cannot access artifacts directory "${artifactsDir}":`,
			error,
		);
		process.exit(1);
	}

	const client = dryRun
		? undefined
		: new Bun.S3Client({
				accessKeyId: requiredEnv("R2_ACCESS_KEY_ID"),
				secretAccessKey: requiredEnv("R2_SECRET_ACCESS_KEY"),
				endpoint: `https://${requiredEnv("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
				region: "auto",
				bucket: KITCHEN_ARTIFACT_BUCKET,
			});

	console.log(
		`${dryRun ? "Checking" : "Publishing"} artifacts from ${artifactsDir} to ${KITCHEN_ARTIFACT_BUCKET}/${KITCHEN_ARTIFACT_PREFIX}/`,
	);

	const files: string[] = [];
	for await (const filePath of walk(artifactsDir)) {
		files.push(filePath);
	}

	if (files.length === 0) {
		console.warn("No files found to upload.");
		return;
	}

	const uploads = files
		.map((filePath) => ({ filePath, key: kitchenArtifactKey(filePath) }))
		.sort((left, right) => left.key.localeCompare(right.key));
	const uniqueKeys = new Set(uploads.map(({ key }) => key));
	if (uniqueKeys.size !== uploads.length) {
		throw new Error("Duplicate Kitchen artifact filenames were staged");
	}

	const payloads = uploads.filter(({ key }) => !isKitchenUpdateManifest(key));
	const manifests = uploads.filter(({ key }) => isKitchenUpdateManifest(key));
	const concurrency = 5;
	let uploadedCount = 0;

	const uploadFile = async (filePath: string, key: string) => {
		const file = Bun.file(filePath);
		const size = file.size ?? "unknown";

		console.log(`  ${key} (${size} bytes)`);

		if (client) {
			await client.write(
				key,
				file,
				file.type ? { type: file.type } : undefined,
			);
		}

		uploadedCount += 1;
	};

	const uploadBatch = async (batch: typeof uploads) => {
		let nextIndex = 0;
		const failures: unknown[] = [];
		const worker = async () => {
			while (true) {
				const upload = batch[nextIndex++];
				if (!upload) break;

				try {
					await uploadFile(upload.filePath, upload.key);
				} catch (error) {
					failures.push(error);
					console.error(`Failed to upload ${upload.filePath}:`, error);
				}
			}
		};

		await Promise.all(
			Array.from(
				{ length: Math.min(concurrency, batch.length) },
				() => worker(),
			),
		);
		if (failures.length > 0) {
			throw new Error(`${failures.length} file(s) failed to upload`);
		}
	};

	await uploadBatch(payloads);
	await uploadBatch(manifests);

	console.log(
		`${dryRun ? "Validated" : "Published"} ${uploadedCount} file(s)${dryRun ? "" : " to R2"}.`,
	);
}

if (import.meta.main) {
	await main().catch((error) => {
		console.error("Upload failed:", error);
		process.exit(1);
	});
}
