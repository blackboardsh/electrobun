export type BeforeRemoveHook = () => void;

/**
 * One-shot synchronous hooks for tearing down resources that still depend on
 * a native object. Errors are collected so every hook gets a chance to run.
 */
export class BeforeRemoveHooks {
	private readonly hooks = new Set<BeforeRemoveHook>();
	private didRun = false;

	subscribe(hook: BeforeRemoveHook): () => void {
		if (this.didRun) return () => {};
		this.hooks.add(hook);
		let subscribed = true;
		return () => {
			if (!subscribed) return;
			subscribed = false;
			this.hooks.delete(hook);
		};
	}

	run(): unknown[] {
		if (this.didRun) return [];
		this.didRun = true;
		const hooks = [...this.hooks];
		this.hooks.clear();
		const errors: unknown[] = [];
		for (const hook of hooks) {
			try {
				hook();
			} catch (error) {
				errors.push(error);
			}
		}
		return errors;
	}
}
