import {
	KITCHEN_ARTIFACT_BUCKET,
	KITCHEN_ARTIFACT_PREFIX,
	KITCHEN_ARTIFACT_PUBLIC_BASE_URL,
} from "./upload-kitchen-artifacts";

// Only the two Kitchen channels are selectable. Bucket, prefix and targets are fixed.
export const KITCHEN_TARGETS = Object.freeze([
	"macos-arm64", "macos-x64", "linux-arm64", "linux-x64", "win-arm64", "win-x64",
] as const);
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_MANIFEST_BYTES = 64 * 1024;
type Channel = "canary" | "stable";
type Options = { expectedVersion: string; channel?: Channel; apply?: boolean };
type Dependencies = {
	fetch?: typeof fetch;
	client?: Pick<InstanceType<typeof Bun.S3Client>, "presign">;
	log?: (message: string) => void;
};

function validateVersion(version: string) {
	if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/.test(version)) {
		throw new Error("An exact --expected-version=<version> is required");
	}
}

function validateChannel(channel: unknown): asserts channel is Channel {
	if (channel !== "canary" && channel !== "stable") {
		throw new Error("--channel must be canary or stable");
	}
}

export function parseCleanupArguments(args: string[]): Options {
	let expectedVersion: string | undefined;
	let channel: string | undefined;
	let mode: string | undefined;
	for (const arg of args) {
		if (arg.startsWith("--expected-version=") && expectedVersion === undefined) {
			expectedVersion = arg.slice("--expected-version=".length);
		} else if (arg.startsWith("--channel=") && channel === undefined) {
			channel = arg.slice("--channel=".length);
		} else if ((arg === "--apply" || arg === "--dry-run") && mode === undefined) {
			mode = arg;
		} else {
			throw new Error(`Unexpected or duplicate argument: ${arg}`);
		}
	}
	validateVersion(expectedVersion ?? "");
	channel ??= "canary";
	validateChannel(channel);
	return { expectedVersion: expectedVersion!, channel, apply: mode === "--apply" };
}

async function readDocument(response: Response, label: string): Promise<any> {
	if (!response.body) throw new Error(`${label} has no body`);
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_MANIFEST_BYTES) throw new Error(`${label} exceeds size limit`);
			chunks.push(value);
		}
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} finally {
		await reader.cancel();
	}
}

function validTarIntegrity(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const { tarSha256, tarSize } = value as Record<string, unknown>;
	return typeof tarSha256 === "string" && /^[a-f0-9]{64}$/.test(tarSha256) &&
		typeof tarSize === "number" && Number.isSafeInteger(tarSize) && tarSize > 0;
}

export async function cleanupKitchenLegacyManifests(
	{ expectedVersion, channel = "canary", apply = false }: Options,
	{ fetch: request = fetch, client, log = console.log }: Dependencies = {},
) {
	validateVersion(expectedVersion);
	validateChannel(channel);
	if (apply && !client) throw new Error("R2 credentials are required for --apply");
	const deletions: string[] = [];
	for (const target of KITCHEN_TARGETS) {
		const prefix = `${channel}-${target}`;
		const response = await request(`${KITCHEN_ARTIFACT_PUBLIC_BASE_URL}/${prefix}-update.json`, {
			redirect: "error", cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (response.status !== 200) {
			await response.body?.cancel();
			throw new Error(`Canonical manifest ${target}: HTTP ${response.status}`);
		}
		const manifest = await readDocument(response, `Canonical manifest ${target}`);
		const [platform, arch] = target.split("-");
		const artifact = manifest?.artifact;
		const expectedFile = `${prefix}-ElectrobunKitchenSink${channel === "canary" ? "-canary" : ""}${platform === "macos" ? ".app" : ""}.tar.zst`;
		if (
			manifest?.schemaVersion !== 1 || manifest.identifier !== "sh.blackboard.electrobun-kitchen" ||
			manifest.version !== expectedVersion || manifest.channel !== channel ||
			manifest.platform !== platform || manifest.arch !== arch ||
			typeof manifest.hash !== "string" || !/^[a-z0-9]{1,13}$/.test(manifest.hash) ||
			artifact?.file !== expectedFile
		) {
			throw new Error(`Canonical manifest ${target} must identify Kitchen ${channel} ${expectedVersion} with valid tar integrity`);
		}
		if (artifact.tarSha256 === undefined && artifact.tarSize === undefined) {
			// Resolve only the validated target/hash beneath the fixed Kitchen base.
			// Cleanup needs proof of the replacement's integrity, so unlike normal
			// update checks a missing sidecar must never permit deletion.
			let checksum = await request(`${KITCHEN_ARTIFACT_PUBLIC_BASE_URL}/${prefix}-checksum.json`, {
				redirect: "error", cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			const legacy = checksum.status === 404;
			if (legacy) {
				await checksum.body?.cancel();
				checksum = await request(`${KITCHEN_ARTIFACT_PUBLIC_BASE_URL}/${prefix}-${manifest.hash}-checksum.json`, {
					redirect: "error", cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				});
			}
			if (checksum.status !== 200) {
				await checksum.body?.cancel();
				throw new Error(`Checksum ${target}: HTTP ${checksum.status}`);
			}
			const document = await readDocument(checksum, `Checksum ${target}`);
			if (!validTarIntegrity(document) ||
				((!legacy || Object.hasOwn(document, "hash")) && document.hash !== manifest.hash)) {
				throw new Error(`Checksum ${target} must contain valid tar integrity for build ${manifest.hash}`);
			}
		} else if (!validTarIntegrity(artifact)) {
			throw new Error(`Canonical manifest ${target} must identify Kitchen ${channel} ${expectedVersion} with valid tar integrity`);
		}
		const payload = await request(`${KITCHEN_ARTIFACT_PUBLIC_BASE_URL}/${artifact.file}`, {
			method: "HEAD", redirect: "error", cache: "no-store",
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		await payload.body?.cancel();
		// tarSize describes the uncompressed archive, not this compressed payload.
		if (payload.status !== 200 || !/^[1-9][0-9]*$/.test(payload.headers.get("content-length") ?? "")) {
			throw new Error(`Canonical payload ${target} is missing or empty: HTTP ${payload.status}`);
		}
		deletions.push(`${KITCHEN_ARTIFACT_PREFIX}/${prefix}-update-v2.json`);
		log(`Verified Kitchen ${channel} ${target} at ${expectedVersion}`);
	}

	// Finish validating every platform before even signing the first DELETE.
	for (const key of deletions) {
		if (apply) {
			let response: Response;
			try {
				const url = client!.presign(key, { method: "DELETE", expiresIn: 60 });
				response = await request(url, {
					method: "DELETE", redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				});
			} catch {
				// Provider/network errors can contain the signed URL and credentials.
				throw new Error(`R2 deletion request failed for ${key}`);
			}
			await response.body?.cancel().catch(() => {});
			if (!response.ok) throw new Error(`R2 deletion failed for ${key}: HTTP ${response.status}`);
		}
		log(`${apply ? "Deleted" : "Dry run: would delete"} ${KITCHEN_ARTIFACT_BUCKET}/${key}`);
	}
	if (apply) {
		// Older updaters fall back only on 404. An origin DELETE alone does not
		// establish that public caches have stopped serving the obsolete manifest.
		for (const target of KITCHEN_TARGETS) {
			const response = await request(`${KITCHEN_ARTIFACT_PUBLIC_BASE_URL}/${channel}-${target}-update-v2.json`, {
				redirect: "error", cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			await response.body?.cancel();
			if (response.status !== 404) {
				throw new Error(`Legacy manifest ${channel}-${target} must return public HTTP 404 after deletion; received HTTP ${response.status}`);
			}
		}
		log(`Verified all six Kitchen ${channel} legacy manifests return public HTTP 404`);
	}
	return deletions;
}

if (import.meta.main) {
	try {
		const options = parseCleanupArguments(process.argv.slice(2));
		const credentials = options.apply ? {
			accountId: process.env.R2_ACCOUNT_ID,
			accessKeyId: process.env.R2_ACCESS_KEY_ID,
			secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
		} : undefined;
		if (credentials && Object.values(credentials).some((value) => !value)) {
			throw new Error("R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY are required for --apply");
		}
		const client = credentials ? new Bun.S3Client({
			accessKeyId: credentials.accessKeyId,
			secretAccessKey: credentials.secretAccessKey,
			endpoint: `https://${credentials.accountId}.r2.cloudflarestorage.com`,
			region: "auto", bucket: KITCHEN_ARTIFACT_BUCKET,
		}) : undefined;
		await cleanupKitchenLegacyManifests(options, { client });
	} catch (error) {
		console.error("Kitchen legacy manifest cleanup refused:", error instanceof Error ? error.message : error);
		process.exit(1);
	}
}
