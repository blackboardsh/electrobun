import { describe, expect, test } from "bun:test";
import {
	createWindowsUpdateTaskPlan,
	executeWindowsUpdateTaskPlan,
} from "./WindowsUpdateTask";
import type { WindowsUpdateTaskCommand } from "./WindowsUpdateTask";

describe("Windows updater scheduled task", () => {
	test("runs on battery and cleans up the exact task", () => {
		const plan = createWindowsUpdateTaskPlan(
			"ElectrobunUpdate_1785634567890",
			"C:\\Users\\Test User\\AppData\\Local\\Example\\update.bat",
		);

		expect(plan.create).toEqual({
			executable: "schtasks.exe",
			args: [
				"/create",
				"/tn",
				"ElectrobunUpdate_1785634567890",
				"/tr",
				'cmd.exe /d /s /c ""C:\\Users\\Test User\\AppData\\Local\\Example\\update.bat""',
				"/sc",
				"once",
				"/st",
				"00:00",
				"/f",
			],
		});
		expect(plan.configure.executable).toBe("powershell.exe");
		expect(plan.configure.args.at(-1)).toContain(
			"-AllowStartIfOnBatteries",
		);
		expect(plan.configure.args.at(-1)).toContain(
			"-DontStopIfGoingOnBatteries",
		);
		expect(plan.configure.args.at(-1)).toContain(
			"$ErrorActionPreference = 'Stop'",
		);
		expect(plan.run.args).toEqual([
			"/run",
			"/tn",
			"ElectrobunUpdate_1785634567890",
		]);
		expect(plan.deleteTask).toEqual({
			executable: "schtasks.exe",
			args: [
				"/delete",
				"/tn",
				"ElectrobunUpdate_1785634567890",
				"/f",
			],
		});
		expect(plan.cleanupBatchLine).toBe(
			'schtasks.exe /delete /tn "ElectrobunUpdate_1785634567890" /f >nul 2>&1',
		);
		expect(plan.cleanupBatchLine).not.toContain("/query");
	});

	test("rejects values that could escape the generated commands", () => {
		expect(() =>
			createWindowsUpdateTaskPlan(
				'ElectrobunUpdate_1" /delete /tn Important',
				"C:\\update.bat",
			),
		).toThrow("Invalid Electrobun update task name");
		expect(() =>
			createWindowsUpdateTaskPlan(
				"ElectrobunUpdate_1",
				'C:\\bad"path\\update.bat',
			),
		).toThrow("Invalid Windows update script path");
	});

	test("deletes a created task before propagating a configure failure", () => {
		const plan = createWindowsUpdateTaskPlan(
			"ElectrobunUpdate_1785634567891",
			"C:\\update.bat",
		);
		const configureError = new Error("configure failed");
		const commands: WindowsUpdateTaskCommand[] = [];
		let thrown: unknown;

		try {
			executeWindowsUpdateTaskPlan(plan, (command) => {
				commands.push(command);
				if (command === plan.configure) throw configureError;
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBe(configureError);
		expect(commands).toEqual([
			plan.create,
			plan.configure,
			plan.deleteTask,
		]);
	});

	test("deletes a created task before propagating a run failure", () => {
		const plan = createWindowsUpdateTaskPlan(
			"ElectrobunUpdate_1785634567892",
			"C:\\update.bat",
		);
		const runError = new Error("run failed");
		const commands: WindowsUpdateTaskCommand[] = [];
		let thrown: unknown;

		try {
			executeWindowsUpdateTaskPlan(plan, (command) => {
				commands.push(command);
				if (command === plan.run) throw runError;
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBe(runError);
		expect(commands).toEqual([
			plan.create,
			plan.configure,
			plan.run,
			plan.deleteTask,
		]);
	});

	test("does not delete when task creation itself fails", () => {
		const plan = createWindowsUpdateTaskPlan(
			"ElectrobunUpdate_1785634567893",
			"C:\\update.bat",
		);
		const createError = new Error("create failed");
		const commands: WindowsUpdateTaskCommand[] = [];
		let thrown: unknown;

		try {
			executeWindowsUpdateTaskPlan(plan, (command) => {
				commands.push(command);
				throw createError;
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBe(createError);
		expect(commands).toEqual([plan.create]);
	});

	test("reports both the task and cleanup failures", () => {
		const plan = createWindowsUpdateTaskPlan(
			"ElectrobunUpdate_1785634567894",
			"C:\\update.bat",
		);
		const configureError = new Error("configure failed");
		const cleanupError = new Error("delete failed");
		let thrown: unknown;

		try {
			executeWindowsUpdateTaskPlan(plan, (command) => {
				if (command === plan.configure) throw configureError;
				if (command === plan.deleteTask) throw cleanupError;
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(AggregateError);
		expect((thrown as AggregateError).errors).toEqual([
			configureError,
			cleanupError,
		]);
	});
});
