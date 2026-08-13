export interface WindowsUpdateTaskCommand {
	executable: string;
	args: string[];
}

export interface WindowsUpdateTaskPlan {
	create: WindowsUpdateTaskCommand;
	configure: WindowsUpdateTaskCommand;
	run: WindowsUpdateTaskCommand;
	deleteTask: WindowsUpdateTaskCommand;
	cleanupBatchLine: string;
}

export type WindowsUpdateTaskCommandExecutor = (
	command: WindowsUpdateTaskCommand,
) => void;

const UPDATE_TASK_NAME_PATTERN = /^ElectrobunUpdate_[a-f0-9]{24}$/;

/**
 * Build the commands used to register and launch the detached Windows updater.
 *
 * schtasks does not expose battery settings through /create. A newly-created
 * task therefore refuses to start on battery and stops if AC power is removed.
 * Apply explicit Task Scheduler settings before starting it, and only then let
 * the caller quit the running application.
 */
export function createWindowsUpdateTaskPlan(
	taskName: string,
	scriptPath: string,
): WindowsUpdateTaskPlan {
	if (!UPDATE_TASK_NAME_PATTERN.test(taskName)) {
		throw new Error(`Invalid Electrobun update task name: ${taskName}`);
	}
	if (/["\r\n]/.test(scriptPath)) {
		throw new Error("Invalid Windows update script path");
	}

	const taskAction = `cmd.exe /d /s /c ""${scriptPath}""`;
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
		cleanupBatchLine: `schtasks.exe /delete /tn "${taskName}" /f >nul 2>&1`,
	};
}

/**
 * Register and start a Windows updater task as a transaction.
 *
 * Once creation succeeds, any configuration or launch failure must remove the
 * generated task before returning control to the running application. Cleanup
 * failures are reported together with the original failure so a possible
 * orphaned task is never hidden.
 */
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
