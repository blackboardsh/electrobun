import { spawn } from "node:child_process";
import { lstatSync, opendirSync } from "node:fs";
import { join } from "node:path";

// A Windows launcher may exit while its delegated manager still owns these
// pipes. Return the live record on exit and keep collecting until pipe close;
// waiting for close here would change the command's timeout/completion contract.
export function runLifecycleCommand(command, args, {
	cwd,
	env,
	label,
	timeout,
	echo = false,
	output = process,
	maxOutputBytes = 4 * 1024 * 1024,
}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const buffers = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
		const record = {
			pid: child.pid ?? null,
			label,
			get stdout() { return buffers.stdout.toString(); },
			get stderr() { return buffers.stderr.toString(); },
			exitCode: null,
			signal: null,
			outputClosed: false,
		};
		const append = (stream, chunk) => {
			buffers[stream] = Buffer.concat([buffers[stream], chunk]).subarray(-maxOutputBytes);
			if (echo) output[stream].write(chunk);
		};
		const fail = (error) => {
			error.commandResult = record;
			reject(error);
		};
		child.stdout.on("data", (chunk) => append("stdout", chunk));
		child.stderr.on("data", (chunk) => append("stderr", chunk));
		child.once("close", () => { record.outputClosed = true; });
		const timer = setTimeout(() => {
			child.kill();
			fail(new Error(`${label} timed out after ${timeout}ms`));
		}, timeout);
		child.once("error", (error) => {
			clearTimeout(timer);
			fail(error);
		});
		child.once("exit", (code, signal) => {
			clearTimeout(timer);
			record.exitCode = code;
			record.signal = signal;
			if (code === 0) resolve(record);
			else fail(new Error(`${label} failed (${code ?? signal}):\n${record.stdout}\n${record.stderr}`));
		});
	});
}

// Record names and metadata only: never read user data or follow a link out of
// the generated fixture. Breadth-first traversal retains root-level state even
// when the application contains more files than the diagnostic budget permits.
export function snapshotLifecycleTree(root, { maxEntries = 128, maxDepth = 4 } = {}) {
	const entries = [];
	const pending = [{ path: root, relativePath: ".", depth: 0 }];
	let truncated = false;
	while (pending.length && entries.length < maxEntries) {
		const current = pending.shift();
		const entry = { path: current.relativePath };
		entries.push(entry);
		try {
			const stat = lstatSync(current.path);
			const kind = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
			Object.assign(entry, { kind, size: stat.size });
			if (kind !== "directory") continue;
			const directory = opendirSync(current.path);
			try {
				let child;
				while ((child = directory.readSync())) {
					if (current.depth >= maxDepth || entries.length + pending.length >= maxEntries) {
						truncated = true;
						break;
					}
					pending.push({
						path: join(current.path, child.name),
						relativePath: current.relativePath === "." ? child.name : `${current.relativePath}/${child.name}`,
						depth: current.depth + 1,
					});
				}
			} finally { directory.closeSync(); }
		} catch (error) {
			entry.error = error.code ?? error.message;
		}
	}
	return { root, entries, truncated: truncated || pending.length > 0 };
}
