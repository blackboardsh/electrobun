import { closeSync, mkdtempSync, openSync, writeFileSync, writeSync } from "node:fs";
import { machine, release, tmpdir } from "node:os";
import { join } from "node:path";

const provenanceEnvironmentKeys = [
	"HUTCH_BINARY",
	"HUTCH_ENGINE_BINARY",
	"HUTCH_LAUNCHER_PATH",
	"HUTCH_ACTIVE_CHANNEL",
	"HUTCH_RUNTIME",
	"HUTCH_ELECTROBUN_TARGET_ARCH",
	"HUTCH_ELECTROBUN_DEVKIT_ROOT",
	"ELECTROBUN_BUILD_ARCH",
	"PROCESSOR_ARCHITECTURE",
	"PROCESSOR_ARCHITEW6432",
];

function environmentProvenance(environment) {
	return Object.fromEntries(provenanceEnvironmentKeys
		.filter((key) => environment[key] !== undefined)
		.map((key) => [key, environment[key]]));
}

function errorDetails(error) {
	return {
		message: error instanceof Error ? error.message : String(error),
		status: Number.isInteger(error?.status) ? error.status : null,
		signal: typeof error?.signal === "string" ? error.signal : null,
		code: typeof error?.code === "string" ? error.code : null,
	};
}

function interrupted(error) {
	return error?.status === 130 || error?.status === 143;
}

function writeAll(descriptor, chunk) {
	let offset = 0;
	while (offset < chunk.length) {
		const written = writeSync(descriptor, chunk, offset, chunk.length - offset);
		if (written === 0) throw new Error("No progress while writing test output.");
		offset += written;
	}
}

// Persist output while it happens, rather than retaining a bounded tail in
// memory. The VM suite can run for hours before its final failure summary.
export function createTestRunDiagnostics(suite, commands, {
	temporaryDirectory = tmpdir(),
	environment = process.env,
} = {}) {
	const directory = mkdtempSync(join(temporaryDirectory, `electrobun-${suite.replace(/[^a-z0-9-]/gi, "-")}-`));
	const summaryPath = join(directory, "summary.json");
	const startedAt = new Date().toISOString();
	const stages = commands.map((command, index) => {
		const name = `${String(index + 1).padStart(2, "0")}-${command.label.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 90)}`;
		return {
			label: command.label,
			command: command.command,
			args: [...command.args],
			cwd: command.cwd,
			requires: command.requires ?? null,
			environment: environmentProvenance({ ...environment, ...command.env }),
			status: "pending",
			startedAt: null,
			finishedAt: null,
			durationMs: null,
			exitStatus: null,
			error: null,
			log: join(directory, `${name}.log`),
			stdoutLog: join(directory, `${name}.stdout.log`),
			stderrLog: join(directory, `${name}.stderr.log`),
		};
	});
	const summary = {
		schemaVersion: 1,
		suite,
		startedAt,
		finishedAt: null,
		status: "running",
		runtime: {
			executable: process.execPath,
			platform: process.platform,
			arch: process.arch,
			machine: machine(),
			osRelease: release(),
			versions: { ...process.versions },
			pid: process.pid,
			environment: environmentProvenance(environment),
		},
		stages,
	};
	const save = () => writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
	const stageFor = (command) => {
		const index = commands.indexOf(command);
		if (index < 0) throw new Error("Cannot record a command outside this test run.");
		return stages[index];
	};
	const recordFailure = (failure) => {
		const stage = stageFor(failure.command);
		if (stage.status === "pending") {
			stage.status = "skipped";
			stage.error = errorDetails(failure.error);
		}
	};
	save();

	return {
		directory,
		summaryPath,
		recordFailure(failure) {
			recordFailure(failure);
			save();
		},
		async run(command, runCommand) {
			const stage = stageFor(command);
			const started = Date.now();
			stage.status = "running";
			stage.startedAt = new Date(started).toISOString();
			save();
			const descriptors = [];
			try {
				for (const path of [stage.log, stage.stdoutLog, stage.stderrLog]) {
					descriptors.push(openSync(path, "w"));
				}
				await runCommand(command, {
					onOutput(stream, chunk) {
						writeAll(descriptors[0], chunk);
						writeAll(descriptors[stream === "stdout" ? 1 : 2], chunk);
					},
				});
				stage.status = "passed";
				stage.exitStatus = 0;
			} catch (error) {
				stage.status = interrupted(error) ? "interrupted" : "failed";
				stage.error = errorDetails(error);
				stage.exitStatus = stage.error.status;
				throw error;
			} finally {
				for (const descriptor of descriptors) closeSync(descriptor);
				stage.finishedAt = new Date().toISOString();
				stage.durationMs = Date.now() - started;
				save();
			}
		},
		finish(failures = [], error = null) {
			for (const failure of failures) recordFailure(failure);
			for (const stage of stages) {
				if (stage.status === "pending") stage.status = "not-run";
			}
			summary.status = interrupted(error) ? "interrupted"
				: error || stages.some((stage) => stage.status !== "passed") ? "failed" : "passed";
			summary.finishedAt = new Date().toISOString();
			if (error) summary.error = errorDetails(error);
			save();
		},
	};
}
