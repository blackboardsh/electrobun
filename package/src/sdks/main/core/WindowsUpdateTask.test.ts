import { describe, expect, test } from "bun:test";
import {
	createWindowsUpdateTaskName,
	createWindowsUpdateTaskPlan,
	executeWindowsUpdateTaskPlan,
	type WindowsUpdateTaskCommand,
} from "./WindowsUpdateTask";

const transactionId = "0123456789abcdef0123456789abcdef";
const taskName = "ApplicationUpdate_0123456789abcdef01234567";
const helperPath =
	"C:\\Users\\Test User\\AppData\\Local\\Temp\\electrobun-update-0123456789abcdef0123456789abcdef.exe";
const planPath =
	"C:\\Users\\Test User\\AppData\\Local\\Example\\stable\\.electrobun-update-0123456789abcdef0123456789abcdef.json";

describe("Windows native update task", () => {
	test("derives a neutral transaction-scoped task name", () => {
		expect(createWindowsUpdateTaskName(transactionId)).toBe(taskName);
		expect(taskName).not.toContain("Electrobun");
		expect(() => createWindowsUpdateTaskName("ABC")).toThrow(
			"Invalid update transaction ID",
		);
	});

	test("runs the copied native helper directly with an immutable plan", () => {
		const plan = createWindowsUpdateTaskPlan(
			taskName,
			helperPath,
			planPath,
		);
		expect(plan.create.args).toContain(
			`"${helperPath}" --apply-update "${planPath}" --quiet`,
		);
		expect(plan.create.args.join(" ")).not.toContain("cmd.exe");
		expect(plan.create.args.join(" ")).not.toContain(".bat");
		expect(plan.configure.args.at(-1)).toContain("-AllowStartIfOnBatteries");
		expect(plan.configure.args.at(-1)).toContain(
			"-DontStopIfGoingOnBatteries",
		);
		expect(plan.run.args).toEqual(["/run", "/tn", taskName]);
		expect(plan.deleteTask.args).toEqual([
			"/delete",
			"/tn",
			taskName,
			"/f",
		]);
	});

	test("validates Windows paths independently of the host path semantics", () => {
		expect(() =>
			createWindowsUpdateTaskPlan(taskName, helperPath, planPath),
		).not.toThrow();
		expect(() =>
			createWindowsUpdateTaskPlan(
				taskName,
				"/tmp/electrobun-update.exe",
				planPath,
			),
		).toThrow("Invalid Windows update helper path");
	});

	test("rejects task and path injection", () => {
		expect(() =>
			createWindowsUpdateTaskPlan(
				'ApplicationUpdate_0123456789abcdef0123456"',
				helperPath,
				planPath,
			),
		).toThrow("Invalid application update task name");
		expect(() =>
			createWindowsUpdateTaskPlan(
				taskName,
				'C:\\bad" --delete',
				planPath,
			),
		).toThrow("Invalid Windows update helper path");
		expect(() =>
			createWindowsUpdateTaskPlan(
				taskName,
				helperPath,
				"relative-plan.json",
			),
		).toThrow("Invalid Windows update plan path");
	});

	for (const failedStep of ["configure", "run"] as const) {
		test(`deletes a created task after ${failedStep} failure`, () => {
			const plan = createWindowsUpdateTaskPlan(
				taskName,
				helperPath,
				planPath,
			);
			const failure = new Error(`${failedStep} failed`);
			const commands: WindowsUpdateTaskCommand[] = [];
			expect(() =>
				executeWindowsUpdateTaskPlan(plan, (command) => {
					commands.push(command);
					if (command === plan[failedStep]) throw failure;
				}),
			).toThrow(failure);
			expect(commands.at(-1)).toBe(plan.deleteTask);
		});
	}

	test("does not delete a task whose creation failed", () => {
		const plan = createWindowsUpdateTaskPlan(
			taskName,
			helperPath,
			planPath,
		);
		const commands: WindowsUpdateTaskCommand[] = [];
		expect(() =>
			executeWindowsUpdateTaskPlan(plan, (command) => {
				commands.push(command);
				throw new Error("create failed");
			}),
		).toThrow("create failed");
		expect(commands).toEqual([plan.create]);
	});

	test("reports both launch and cleanup failures", () => {
		const plan = createWindowsUpdateTaskPlan(
			taskName,
			helperPath,
			planPath,
		);
		let thrown: unknown;
		try {
			executeWindowsUpdateTaskPlan(plan, (command) => {
				if (command === plan.configure) throw new Error("configure failed");
				if (command === plan.deleteTask) throw new Error("delete failed");
			});
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(AggregateError);
		expect((thrown as AggregateError).errors).toHaveLength(2);
	});
});
