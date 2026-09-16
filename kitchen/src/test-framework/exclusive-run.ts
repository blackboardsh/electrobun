export class RunAlreadyInProgressError extends Error {
	constructor(
		readonly activeRun: string,
		readonly requestedRun: string,
	) {
		super(
			`Cannot start ${requestedRun} while ${activeRun} is already running`,
		);
		this.name = "RunAlreadyInProgressError";
	}
}

/**
 * Rejects overlapping top-level operations while allowing a single operation
 * to coordinate as much private/internal work as it needs.
 */
export class ExclusiveRunCoordinator {
	private activeRun: string | undefined;

	get currentRun(): string | undefined {
		return this.activeRun;
	}

	async run<T>(description: string, operation: () => Promise<T>): Promise<T> {
		if (this.activeRun) {
			throw new RunAlreadyInProgressError(this.activeRun, description);
		}

		this.activeRun = description;
		try {
			return await operation();
		} finally {
			this.activeRun = undefined;
		}
	}
}
