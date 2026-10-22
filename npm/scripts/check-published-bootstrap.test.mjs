import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	checkPublishedBootstrap,
	compareSemver,
	npmInvocation,
	packBootstrapIntegrity,
} from "./check-published-bootstrap.mjs";

const registry = "https://registry.test";

function fixture(version = "2.3.4-beta.5") {
	const root = mkdtempSync(join(tmpdir(), "electrobun-npm-published-"));
	const manifestPath = join(root, "package.json");
	writeFileSync(manifestPath, JSON.stringify({ name: "electrobun", version }));
	return { manifestPath, root, version };
}

function response(status, value) {
	const bytes = Buffer.from(JSON.stringify(value));
	return {
		arrayBuffer: async () => bytes,
		headers: { get: () => `${bytes.length}` },
		ok: status >= 200 && status < 300,
		status,
	};
}

function registryFetch({
	calls = [],
	tags = {},
	tagsStatus = 200,
	versionMetadata = {},
	versionStatus = 200,
} = {}) {
	return async (url) => {
		calls.push(url);
		return url.includes("/-/package/")
			? response(tagsStatus, tags)
			: response(versionStatus, versionMetadata);
	};
}

function retryFixture(t) {
	const value = fixture();
	t.after(() => rmSync(value.root, { recursive: true, force: true }));
	const sleeps = [], logs = [];
	return {
		...value,
		versionUrl: `${registry}/electrobun/${value.version}`,
		tagsUrl: `${registry}/-/package/electrobun/dist-tags`,
		sleeps,
		logs,
		options: {
			...value,
			distTag: "beta",
			registry,
			requestTimeoutMs: 20,
			sleepImpl: async milliseconds => { sleeps.push(milliseconds); },
			log: message => { logs.push(message); },
		},
	};
}

function abortPendingRequest(signal) {
	return new Promise((_, reject) => {
		const abort = () => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
	});
}

function networkFailure(code) {
	return new TypeError("fetch failed", { cause: Object.assign(new Error("connection failed"), { code }) });
}

function assertRequestDiagnostic(message, { url, label, attempt, timeout = 20, code }) {
	assert.ok(message.includes(url), `missing request URL: ${message}`);
	assert.ok(message.includes(label), `missing metadata label: ${message}`);
	assert.ok(message.includes(`attempt ${attempt}/3`), `missing attempt count: ${message}`);
	assert.match(message, /(?:after|elapsed) \d+ms/, "missing elapsed request time");
	assert.ok(message.includes(`deadline ${timeout}ms`), `missing request deadline: ${message}`);
	if (code) assert.ok(message.includes(code), `missing transport cause: ${message}`);
}

async function rejectPublicationFailureWithoutRetry(options, expected) {
	const calls = [];
	await assert.rejects(checkPublishedBootstrap({
		...options,
		fetchImpl: async (...args) => {
			calls.push(args[0]);
			return options.fetchImpl(...args);
		},
		sleepImpl: async () => { assert.fail("publication policy failures must not retry"); },
		log: () => { assert.fail("publication policy failures must not log a retry"); },
	}), expected);
	assert.deepEqual(calls, [
		`${options.registry}/electrobun/${options.version}`,
		`${options.registry}/-/package/electrobun/dist-tags`,
	]);
}

test("reuses only an integrity-identical version on the requested dist-tag", async () => {
	const value = fixture();
	const integrity = `sha512-${Buffer.from("expected-integrity").toString("base64")}`;
	const calls = [];
	try {
		assert.equal(
			await checkPublishedBootstrap({
				...value,
				distTag: "beta",
				fetchImpl: registryFetch({
					calls,
					tags: { beta: value.version },
					versionMetadata: {
						name: "electrobun",
						version: value.version,
						dist: { integrity },
					},
				}),
				packIntegrity: () => integrity,
				registry,
			}),
			true,
		);
		assert.deepEqual(calls, [
			`${registry}/electrobun/${value.version}`,
			`${registry}/-/package/electrobun/dist-tags`,
		]);
	} finally {
		rmSync(value.root, { recursive: true, force: true });
	}
});

test("an unpublished version may advance a missing or older beta/latest tag", async () => {
	for (const candidate of [
		{ distTag: "beta", version: "2.3.4-beta.5", tagged: undefined },
		{ distTag: "beta", version: "2.3.4-beta.5", tagged: "2.3.4-beta.4" },
		{ distTag: "latest", version: "2.3.4", tagged: undefined },
		{ distTag: "latest", version: "2.3.4", tagged: "2.3.3" },
	]) {
		const value = fixture(candidate.version);
		try {
			assert.equal(
				await checkPublishedBootstrap({
					...value,
					distTag: candidate.distTag,
					fetchImpl: registryFetch({
						tags:
							candidate.tagged === undefined
								? {}
								: { [candidate.distTag]: candidate.tagged },
						versionStatus: 404,
					}),
					registry,
				}),
				false,
				JSON.stringify(candidate),
			);
		} finally {
			rmSync(value.root, { recursive: true, force: true });
		}
	}
});

test("an unpublished version cannot move beta or latest backward", async () => {
	for (const candidate of [
		{ distTag: "beta", version: "2.3.4-beta.5", tagged: "2.3.4-beta.6" },
		{ distTag: "latest", version: "2.3.4", tagged: "2.3.5" },
	]) {
		const value = fixture(candidate.version);
		try {
			await rejectPublicationFailureWithoutRetry(
				{
					...value,
					distTag: candidate.distTag,
					fetchImpl: registryFetch({
						tags: { [candidate.distTag]: candidate.tagged },
						versionStatus: 404,
					}),
					registry,
				},
				/move npm dist-tag .* backward from newer/,
			);
		} finally {
			rmSync(value.root, { recursive: true, force: true });
		}
	}
});

test("an existing exact version fails closed on stale tag, registry, or integrity", async () => {
	const value = fixture();
	const integrity = `sha512-${Buffer.from("published").toString("base64")}`;
	const metadata = {
		name: "electrobun",
		version: value.version,
		dist: { integrity },
	};
	try {
		await assert.rejects(
			checkPublishedBootstrap({
				...value,
				distTag: "beta",
				fetchImpl: registryFetch({ versionStatus: 503 }),
				registry,
				sleepImpl: async () => {},
				log: () => {},
			}),
			/HTTP 503/,
		);
		await rejectPublicationFailureWithoutRetry(
			{
				...value,
				distTag: "beta",
				fetchImpl: registryFetch({
					tags: { beta: value.version },
					versionMetadata: { ...metadata, version: "2.3.4" },
				}),
				packIntegrity: () => integrity,
				registry,
			},
			/identity does not match/,
		);
		await rejectPublicationFailureWithoutRetry(
			{
				...value,
				distTag: "beta",
				fetchImpl: registryFetch({
					tags: { beta: value.version },
					versionMetadata: metadata,
				}),
				packIntegrity: () =>
					`sha512-${Buffer.from("different").toString("base64")}`,
				registry,
			},
			/dist\.integrity does not match/,
		);
		for (const tags of [{}, { beta: "2.3.4-beta.4" }]) {
			await rejectPublicationFailureWithoutRetry(
				{
					...value,
					distTag: "beta",
					fetchImpl: registryFetch({ tags, versionMetadata: metadata }),
					packIntegrity: () => integrity,
					registry,
				},
				/repair it with "npm dist-tag add/,
			);
		}
		await rejectPublicationFailureWithoutRetry(
			{
				...value,
				distTag: "beta",
				fetchImpl: registryFetch({
					tags: { beta: "2.3.4-beta.6" },
					versionMetadata: metadata,
				}),
				packIntegrity: () => integrity,
				registry,
			},
			(error) => {
				assert.match(error.message, /refusing to move it backward/);
				assert.doesNotMatch(error.message, /npm dist-tag add/);
				return true;
			},
		);
	} finally {
		rmSync(value.root, { recursive: true, force: true });
	}
});

test("an actual request timeout retries with fresh signals and clears successful timers", async t => {
	const value = retryFixture(t);
	const calls = [], signals = [];
	const result = await checkPublishedBootstrap({
		...value.options,
		fetchImpl: async (url, { signal }) => {
			calls.push(url); signals.push(signal);
			if (calls.length === 1) return abortPendingRequest(signal);
			return url === value.versionUrl ? response(404, {}) : response(200, {});
		},
	});
	assert.equal(result, false);
	assert.deepEqual(calls, [value.versionUrl, value.versionUrl, value.tagsUrl]);
	assert.deepEqual(value.sleeps, [1000]);
	assert.equal(value.logs.length, 1);
	assertRequestDiagnostic(value.logs[0], { url: value.versionUrl, label: "version metadata", attempt: 1 });
	assert.match(value.logs[0], /timed out after 20ms/);
	assert.equal(new Set(signals).size, 3);
	await new Promise(resolve => setTimeout(resolve, 30));
	assert.deepEqual(signals.map(signal => signal.aborted), [true, false, false]);
});

test("actual fetch and response-body timeouts stop after three attempts", async t => {
	for (const stage of ["fetch", "body"]) {
		await t.test(stage, async t => {
			const value = retryFixture(t);
			const calls = [];
			await assert.rejects(checkPublishedBootstrap({
				...value.options,
				fetchImpl: async (url, { signal }) => {
					calls.push(url);
					if (stage === "fetch") return abortPendingRequest(signal);
					return { ...response(200, {}), arrayBuffer: () => abortPendingRequest(signal) };
				},
			}), error => {
				assertRequestDiagnostic(error.message, { url: value.versionUrl, label: "version metadata", attempt: 3 });
				assert.match(error.message, /timed out after 20ms/);
				return true;
			});
			assert.deepEqual(calls, Array(3).fill(value.versionUrl));
			assert.deepEqual(value.sleeps, [1000, 2000]);
			assert.equal(value.logs.length, 2);
		});
	}
});

test("a transport reset while reading the response body retries that GET", async t => {
	const value = retryFixture(t);
	const calls = [];
	assert.equal(await checkPublishedBootstrap({
		...value.options,
		fetchImpl: async url => {
			calls.push(url);
			if (calls.length === 1) {
				return { ...response(200, {}), arrayBuffer: async () => { throw networkFailure("ECONNRESET"); } };
			}
			return url === value.versionUrl ? response(404, {}) : response(200, {});
		},
	}), false);
	assert.deepEqual(calls, [value.versionUrl, value.versionUrl, value.tagsUrl]);
	assert.deepEqual(value.sleeps, [1000]);
	assertRequestDiagnostic(value.logs[0], { url: value.versionUrl, label: "version metadata", attempt: 1, code: "ECONNRESET" });
});

test("a transient dist-tag request does not refetch successful version metadata", async t => {
	const value = retryFixture(t);
	const calls = [];
	assert.equal(await checkPublishedBootstrap({
		...value.options,
		fetchImpl: async url => {
			calls.push(url);
			if (url === value.versionUrl) return response(404, {});
			if (calls.length === 2) throw networkFailure("EAI_AGAIN");
			return response(200, { beta: "2.3.4-beta.4" });
		},
	}), false);
	assert.deepEqual(calls, [value.versionUrl, value.tagsUrl, value.tagsUrl]);
	assert.deepEqual(value.sleeps, [1000]);
	assertRequestDiagnostic(value.logs[0], { url: value.tagsUrl, label: "dist-tag metadata", attempt: 1, code: "EAI_AGAIN" });
});

test("selected transient HTTP failures recover without weakening 404 absence", async t => {
	for (const status of [408, 429, 500, 502, 503, 504]) {
		await t.test(`HTTP ${status}`, async t => {
			const value = retryFixture(t);
			const calls = [];
			assert.equal(await checkPublishedBootstrap({
				...value.options,
				fetchImpl: async url => {
					calls.push(url);
					if (calls.length === 1) return response(status, {});
					return response(404, {});
				},
			}), false);
			assert.deepEqual(calls, [value.versionUrl, value.versionUrl, value.tagsUrl]);
			assert.deepEqual(value.sleeps, [1000]);
			assert.match(value.logs[0], new RegExp(`HTTP ${status}`));
		});
	}
});

test("persistent transient HTTP failures stop after three requests with actionable diagnostics", async t => {
	const value = retryFixture(t);
	const calls = [];
	await assert.rejects(checkPublishedBootstrap({
		...value.options,
		fetchImpl: registryFetch({ calls, versionStatus: 503 }),
	}), error => {
		assertRequestDiagnostic(error.message, { url: value.versionUrl, label: "version metadata", attempt: 3 });
		assert.match(error.message, /HTTP 503/);
		return true;
	});
	assert.deepEqual(calls, Array(3).fill(value.versionUrl));
	assert.deepEqual(value.sleeps, [1000, 2000]);
	assert.equal(value.logs.length, 2);
});

test("only recognized transport cause codes receive a recovery attempt", async t => {
	for (const code of ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET"]) {
		await t.test(code, async t => {
			const value = retryFixture(t);
			const calls = [];
			assert.equal(await checkPublishedBootstrap({
				...value.options,
				fetchImpl: async url => {
					calls.push(url);
					if (calls.length === 1) throw networkFailure(code);
					return response(404, {});
				},
			}), false);
			assert.deepEqual(calls, [value.versionUrl, value.versionUrl, value.tagsUrl]);
			assert.deepEqual(value.sleeps, [1000]);
			assertRequestDiagnostic(value.logs[0], { url: value.versionUrl, label: "version metadata", attempt: 1, code });
		});
	}
});

test("permanent HTTP, TLS, generic TypeError, and foreign abort failures never retry", async t => {
	for (const [name, produce] of [
		["HTTP 403", () => response(403, {})],
		["HTTP 501", () => response(501, {})],
		["TLS", () => { throw networkFailure("CERT_HAS_EXPIRED"); }],
		["generic TypeError", () => { throw new TypeError("fetch failed"); }],
		["foreign AbortError", () => { throw new DOMException("external cancellation", "AbortError"); }],
	]) {
		await t.test(name, async t => {
			const value = retryFixture(t);
			const calls = [];
			await assert.rejects(checkPublishedBootstrap({
				...value.options,
				fetchImpl: async url => { calls.push(url); return produce(); },
			}), error => {
				assertRequestDiagnostic(error.message, { url: value.versionUrl, label: "version metadata", attempt: 1 });
				if (name === "TLS") assert.match(error.message, /CERT_HAS_EXPIRED/);
				if (name === "foreign AbortError") assert.doesNotMatch(error.message, /timed out/);
				return true;
			});
			assert.deepEqual(calls, [value.versionUrl]);
			assert.deepEqual(value.sleeps, []);
			assert.deepEqual(value.logs, []);
		});
	}
});

test("permanent HTTP status remains decisive when response cleanup reaches the deadline", async t => {
	const value = retryFixture(t);
	const calls = [];
	await assert.rejects(checkPublishedBootstrap({
		...value.options,
		fetchImpl: async (url, { signal }) => {
			calls.push(url);
			return { ...response(403, {}), body: { cancel: () => abortPendingRequest(signal) } };
		},
	}), error => {
		assert.match(error.message, /HTTP 403/);
		assert.doesNotMatch(error.message, /timed out/);
		return true;
	});
	assert.deepEqual(calls, [value.versionUrl]);
	assert.deepEqual(value.sleeps, []);
	assert.deepEqual(value.logs, []);
});

test("invalid and oversized registry data never trigger transport retries", async t => {
	for (const [name, produce, expected] of [
		["invalid JSON", () => ({ ...response(200, {}), arrayBuffer: async () => Buffer.from("{invalid") }), /invalid JSON/],
		["non-object JSON", () => response(200, []), /must be an object/],
		["declared oversize", () => ({ ...response(200, {}), headers: { get: () => `${1024 * 1024 + 1}` } }), /exceeds its size limit/],
		["undeclared oversize", () => ({ ...response(200, {}), headers: { get: () => null }, arrayBuffer: async () => Buffer.alloc(1024 * 1024 + 1) }), /exceeds its size limit/],
	]) {
		await t.test(name, async t => {
			const value = retryFixture(t);
			const calls = [];
			await assert.rejects(checkPublishedBootstrap({
				...value.options,
				fetchImpl: async url => { calls.push(url); return produce(); },
			}), expected);
			assert.deepEqual(calls, [value.versionUrl]);
			assert.deepEqual(value.sleeps, []);
			assert.deepEqual(value.logs, []);
		});
	}
});

test("the retry deadline override cannot disable or extend the request bound", async t => {
	for (const requestTimeoutMs of [0, -1, 1.5, 30_001, Infinity, NaN, "20"]) {
		const value = retryFixture(t);
		let calls = 0;
		await assert.rejects(checkPublishedBootstrap({
			...value.options,
			requestTimeoutMs,
			fetchImpl: async () => { calls++; return response(404, {}); },
		}), /timeout must be an integer from 1 to 30000ms/);
		assert.equal(calls, 0);
		assert.deepEqual(value.sleeps, []);
	}
});

test("SemVer precedence handles prereleases for monotonic tags", () => {
	for (const [left, right, expected] of [
		["2.3.4-beta.4", "2.3.4-beta.5", -1],
		["2.3.4-beta.10", "2.3.4-beta.5", 1],
		["2.3.4", "2.3.4-beta.5", 1],
		["2.3.4-alpha", "2.3.4-alpha.1", -1],
		["2.3.4+one", "2.3.4+two", 0],
	]) {
		assert.equal(compareSemver(left, right), expected, `${left} vs ${right}`);
	}
});

test("invokes the Windows npm.cmd shim without shell:true or path interpolation", () => {
	const args = ["pack", "--json", "--ignore-scripts"];
	assert.deepEqual(npmInvocation(args, "linux", {}), {
		args,
		command: "npm",
	});
	assert.deepEqual(
		npmInvocation(args, "win32", {
			ComSpec: "C:\\Windows\\System32\\cmd.exe",
		}),
		{
			args: ["/d", "/s", "/c", ["npm.cmd", ...args].join(" ")],
			command: "C:\\Windows\\System32\\cmd.exe",
		},
	);
	assert.throws(
		() => npmInvocation(["pack", "value & whoami"], "win32", {}),
		/unsafe command-string argument/,
	);
});

test("npm pack produces a deterministic local integrity", () => {
	const value = fixture();
	try {
		assert.equal(
			packBootstrapIntegrity(value.manifestPath),
			packBootstrapIntegrity(value.manifestPath),
		);
	} finally {
		rmSync(value.root, { recursive: true, force: true });
	}
});
