export const KITCHEN_MAIN_PROCESSES = [
	"cottontail",
	"bun",
	"zig",
	"rust",
	"go",
	"odin",
] as const;

export const KITCHEN_RENDERERS = ["native", "cef"] as const;

export type KitchenMainProcess = (typeof KITCHEN_MAIN_PROCESSES)[number];
export type KitchenRenderer = (typeof KITCHEN_RENDERERS)[number];

export type KitchenVariant = {
	mainProcess: KitchenMainProcess;
	renderer: KitchenRenderer;
};

export const KITCHEN_MAIN_PROCESS_ENV = "ELECTROBUN_KITCHEN_MAIN_PROCESS";
export const KITCHEN_RENDERER_ENV = "ELECTROBUN_KITCHEN_RENDERER";

export function kitchenVariantKey(variant: KitchenVariant): string {
	return `${variant.mainProcess}-${variant.renderer}`;
}

export function createKitchenMatrix(
	full: boolean,
	selectedVariants?: readonly KitchenVariant[],
): KitchenVariant[] {
	if (selectedVariants) return selectedVariants.map((variant) => ({ ...variant }));

	if (full) {
		return KITCHEN_MAIN_PROCESSES.flatMap((mainProcess) =>
			KITCHEN_RENDERERS.map((renderer) => ({ mainProcess, renderer })),
		);
	}

	// Renderer behavior lives below the main-process SDK bridges. Exercise every
	// bridge against the system renderer, then cover CEF through the first-class
	// Cottontail path. Use --full when renderer or build-config plumbing changes.
	return [
		{ mainProcess: "cottontail", renderer: "native" },
		{ mainProcess: "cottontail", renderer: "cef" },
		...KITCHEN_MAIN_PROCESSES.slice(1).map((mainProcess) => ({
			mainProcess,
			renderer: "native" as const,
		})),
	];
}

function isMainProcess(value: string): value is KitchenMainProcess {
	return KITCHEN_MAIN_PROCESSES.some((candidate) => candidate === value);
}

function isRenderer(value: string): value is KitchenRenderer {
	return KITCHEN_RENDERERS.some((candidate) => candidate === value);
}

export function readKitchenVariant(
	environment: Record<string, string | undefined>,
): KitchenVariant | null {
	const mainProcess = environment[KITCHEN_MAIN_PROCESS_ENV];
	const renderer = environment[KITCHEN_RENDERER_ENV];
	if (!mainProcess && !renderer) return null;
	if (!mainProcess || !renderer) {
		throw new Error(
			`${KITCHEN_MAIN_PROCESS_ENV} and ${KITCHEN_RENDERER_ENV} must be set together`,
		);
	}
	if (!isMainProcess(mainProcess)) {
		throw new Error(`Unsupported kitchen main process: ${mainProcess}`);
	}
	if (!isRenderer(renderer)) {
		throw new Error(`Unsupported kitchen renderer: ${renderer}`);
	}
	return { mainProcess, renderer };
}

export function kitchenVariantEnvironment(
	environment: Record<string, string | undefined>,
	variant: KitchenVariant,
): Record<string, string | undefined> {
	return {
		...environment,
		[KITCHEN_MAIN_PROCESS_ENV]: variant.mainProcess,
		[KITCHEN_RENDERER_ENV]: variant.renderer,
	};
}
