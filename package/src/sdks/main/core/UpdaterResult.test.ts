import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getPlatformPrefix } from "../../../shared/naming";
import { ARCH, OS } from "../../../shared/platform";
import {
	cleanupOlderNativeUpdateResults,
	reconcileNativeUpdateResultState,
	scanNativeUpdateResults,
	validateNativeUpdateResult,
	type LocalUpdateInfo,
	type NativeUpdateResultV1,
} from "./Updater";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function fixtureRoot(): string {
	const root = resolve(mkdtempSync(join(tmpdir(), "electrobun-update-result-")));
	temporaryDirectories.push(root);
	return root;
}

const info: LocalUpdateInfo = {
	identifier: "com.example.application",
	channel: "production",
	version: "2.0.0",
	hash: "current123",
	baseUrl: "https://updates.example.invalid",
	name: "Example",
};

function result(
	transactionId: string,
	overrides: Partial<NativeUpdateResultV1> = {},
): NativeUpdateResultV1 {
	return {
		schema_version: 1,
		transaction_id: transactionId,
		success: true,
		phase: "complete",
		message: "Update applied successfully.",
		identifier: info.identifier,
		channel: info.channel,
		version: info.version,
		hash: info.hash,
		...overrides,
	};
}

function writeResult(
	root: string,
	transactionId: string,
	value: NativeUpdateResultV1 | Record<string, unknown>,
	modifiedAt: number,
): string {
	const path = join(
		root,
		`.electrobun-update-${transactionId}.result.json`,
	);
	writeFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
	const timestamp = new Date(modifiedAt);
	utimesSync(path, timestamp, timestamp);
	return path;
}

function writePreparedUpdate(root: string, version: string, hash: string): void {
	const extraction = join(root, "self-extraction");
	mkdirSync(extraction, { recursive: true });
	const retainedTarPath = resolve(join(extraction, `${hash}.tar`));
	writeFileSync(retainedTarPath, "prepared tar");
	writeFileSync(
		join(extraction, ".electrobun-prepared-update.json"),
		`${JSON.stringify({
			schema_version: 1,
			identifier: info.identifier,
			channel: info.channel,
			version,
			hash,
			platform: OS,
			arch: ARCH,
			retained_tar_path: retainedTarPath,
			artifact_file: `${getPlatformPrefix(info.channel, OS, ARCH)}-Example.tar.zst`,
			artifact_size: 123,
			artifact_sha256: "a".repeat(64),
		})}\n`,
		"utf8",
	);
}

describe("native update result reconciliation", () => {
	test("validates the exact result schema, transaction, identity, and state", () => {
		const transactionId = "0123456789abcdef0123456789abcdef";
		expect(
			validateNativeUpdateResult(result(transactionId), transactionId, info),
		).toEqual(result(transactionId));
		for (const invalid of [
			{ ...result(transactionId), schema_version: 2 },
			{ ...result(transactionId), transaction_id: "f".repeat(32) },
			{ ...result(transactionId), identifier: "com.example.other" },
			{ ...result(transactionId), version: "" },
			{ ...result(transactionId), hash: "../escape" },
			{ ...result(transactionId), success: false },
			{ ...result(transactionId), unexpected: true },
		]) {
			expect(() =>
				validateNativeUpdateResult(invalid, transactionId, info),
			).toThrow();
		}
	});

	test("maps success and failure to compatible updater state and statuses", () => {
		const transactionId = "0123456789abcdef0123456789abcdef";
		const success = reconcileNativeUpdateResultState(
			result(transactionId),
			info,
		);
		expect(success.status).toBe("complete");
		expect(success.updateInfo).toEqual({
			version: info.version,
			hash: info.hash,
			updateAvailable: false,
			updateReady: false,
			error: "",
		});

		const failure = reconcileNativeUpdateResultState(
			result(transactionId, {
				success: false,
				phase: "validating_payload",
				message: "InvalidUpdateIdentity",
				version: "3.0.0",
				hash: "target123",
			}),
			info,
		);
		expect(failure.status).toBe("error");
		expect(failure.updateInfo.updateAvailable).toBe(true);
		expect(failure.updateInfo.updateReady).toBe(false);
		expect(failure.updateInfo.error).toContain("InvalidUpdateIdentity");
	});

	test("selects a failed target after invalid prepared state was removed", () => {
		const root = fixtureRoot();
		const transactionId = "55555555555555555555555555555555";
		const failed = writeResult(
			root,
			transactionId,
			result(transactionId, {
				success: false,
				phase: "validating_payload",
				message: "InvalidArchive",
				version: "3.0.0",
				hash: "target123",
			}),
			Date.now(),
		);

		const scan = scanNativeUpdateResults(info, root);
		expect(scan.truncated).toBe(false);
		expect(scan.selected?.path).toBe(failed);
	});

	test("selects the newest relevant result and prunes only older valid results", () => {
		const root = fixtureRoot();
		writePreparedUpdate(root, "3.0.0", "target123");
		const successful = writeResult(
			root,
			"11111111111111111111111111111111",
			result("11111111111111111111111111111111"),
			1_000,
		);
		const olderVersion = writeResult(
			root,
			"22222222222222222222222222222222",
			result("22222222222222222222222222222222", {
				version: "1.0.0",
				hash: "older123",
			}),
			2_000,
		);
		const failed = writeResult(
			root,
			"33333333333333333333333333333333",
			result("33333333333333333333333333333333", {
				success: false,
				phase: "extracting",
				message: "InvalidArchive",
				version: "3.0.0",
				hash: "target123",
			}),
			3_000,
		);
		const malformed = writeResult(
			root,
			"44444444444444444444444444444444",
			{
				...result("44444444444444444444444444444444"),
				unexpected: true,
			},
			4_000,
		);

		const scan = scanNativeUpdateResults(info, root);
		expect(scan.truncated).toBe(false);
		expect(scan.candidates).toHaveLength(3);
		expect(scan.selected?.path).toBe(failed);

		expect(cleanupOlderNativeUpdateResults(info, root).sort()).toEqual(
			[successful, olderVersion].sort(),
		);
		expect(existsSync(failed)).toBe(true);
		expect(existsSync(malformed)).toBe(true);
	});

	test("refuses an unbounded result directory scan", () => {
		const root = fixtureRoot();
		for (let index = 0; index <= 64; index += 1) {
			const transactionId = index.toString(16).padStart(32, "0");
			writeResult(root, transactionId, result(transactionId), 1_000 + index);
		}
		const scan = scanNativeUpdateResults(info, root);
		expect(scan.truncated).toBe(true);
		expect(scan.candidates).toHaveLength(0);
	});
});
