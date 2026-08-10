import type { TestResult } from "./types";

type Quit = (code?: number) => void;
type Schedule = (callback: () => void, delayMs: number) => unknown;

export const autoRunExitCode = (
	results: readonly Pick<TestResult, "status">[],
): number => (results.some((result) => result.status === "failed") ? 1 : 0);

export const scheduleAutoRunExit = (
	exitCode: number,
	quit: Quit,
	schedule: Schedule = setTimeout,
): unknown => schedule(() => quit(exitCode), 500);
