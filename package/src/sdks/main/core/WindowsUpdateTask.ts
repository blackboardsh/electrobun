import { win32 } from "node:path";

export interface WindowsUpdateTaskCommand {
	executable: string;
	args: string[];
}

export interface WindowsUpdateTaskPlan {
	create: WindowsUpdateTaskCommand;
	configure: WindowsUpdateTaskCommand;
	run: WindowsUpdateTaskCommand;
	deleteTask: WindowsUpdateTaskCommand;
}

export type WindowsUpdateTaskCommandExecutor = (
	command: WindowsUpdateTaskCommand,
) => void;

const TRANSACTION_ID_PATTERN = /^[a-f0-9]{32}$/;
const UPDATE_TASK_NAME_PATTERN = /^ApplicationUpdate_[a-f0-9]{24}$/;

export function createWindowsUpdateTaskName(transactionId: string): string {
	if (!TRANSACTION_ID_PATTERN.test(transactionId)) {
		throw new Error("Invalid update transaction ID");
	}
	return `ApplicationUpdate_${transactionId.slice(0, 24)}`;
}

function requireSafeAbsolutePath(path: string, description: string): void {
	const root = win32.parse(path).root;
	const isFullyQualified = root !== "\\" && root !== "/";
	if (!win32.isAbsolute(path) || !isFullyQualified || /["\r\n]/.test(path)) {
		throw new Error(`Invalid Windows update ${description} path`);
	}
}

/** Register the copied native manager itself as the scheduled task action. */
export function createWindowsUpdateTaskPlan(
	taskName: string,
	helperPath: string,
	planPath: string,
): WindowsUpdateTaskPlan {
	if (!UPDATE_TASK_NAME_PATTERN.test(taskName)) {
		throw new Error(`Invalid application update task name: ${taskName}`);
	}
	requireSafeAbsolutePath(helperPath, "helper");
	requireSafeAbsolutePath(planPath, "plan");

	const taskAction = `"${helperPath}" --apply-update "${planPath}" --quiet`;
	const settingsScript = [
		"$ErrorActionPreference = 'Stop'",
		"$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries",
		`Set-ScheduledTask -TaskName '${taskName}' -Settings $settings | Out-Null`,
	].join("; ");

	return {
		create: {
			executable: "schtasks.exe",
			args: [
				"/create",
				"/tn",
				taskName,
				"/tr",
				taskAction,
				"/sc",
				"once",
				"/st",
				"00:00",
				"/f",
			],
		},
		configure: {
			executable: "powershell.exe",
			args: ["-NoProfile", "-NonInteractive", "-Command", settingsScript],
		},
		run: {
			executable: "schtasks.exe",
			args: ["/run", "/tn", taskName],
		},
		deleteTask: {
			executable: "schtasks.exe",
			args: ["/delete", "/tn", taskName, "/f"],
		},
	};
}

/** Configure and start a scheduled update task as one cleanup-aware action. */
export function executeWindowsUpdateTaskPlan(
	plan: WindowsUpdateTaskPlan,
	execute: WindowsUpdateTaskCommandExecutor,
): void {
	let created = false;
	try {
		execute(plan.create);
		created = true;
		execute(plan.configure);
		execute(plan.run);
	} catch (error) {
		if (created) {
			try {
				execute(plan.deleteTask);
			} catch (cleanupError) {
				throw new AggregateError(
					[error, cleanupError],
					"Failed to start Windows update task and clean it up",
				);
			}
		}
		throw error;
	}
}
