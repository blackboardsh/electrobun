export const WGPULoadOp = {
	Undefined: 0x00000000,
	Load: 0x00000001,
	Clear: 0x00000002,
} as const;

export const WGPUStoreOp = {
	Undefined: 0x00000000,
	Store: 0x00000001,
	Discard: 0x00000002,
} as const;

type LoadOp = string | number | null | undefined;
type StoreOp = string | number | null | undefined;

export type RenderPassDepthStencilFields = {
	depthClearValue?: number;
	depthLoadOp?: LoadOp;
	depthStoreOp?: StoreOp;
	depthReadOnly?: boolean;
	stencilClearValue?: number;
	stencilLoadOp?: LoadOp;
	stencilStoreOp?: StoreOp;
	stencilReadOnly?: boolean;
};

export function mapLoadOp(op: LoadOp): number {
	if (typeof op === "number") return op;
	return op === "load" ? WGPULoadOp.Load : WGPULoadOp.Clear;
}

export function mapStoreOp(op: StoreOp): number {
	if (typeof op === "number") return op;
	return op === "discard" ? WGPUStoreOp.Discard : WGPUStoreOp.Store;
}

function mapOptionalLoadOp(op: LoadOp): number {
	return op == null ? WGPULoadOp.Undefined : mapLoadOp(op);
}

function mapOptionalStoreOp(op: StoreOp): number {
	return op == null ? WGPUStoreOp.Undefined : mapStoreOp(op);
}

export function normalizeRenderPassDepthStencilFields(
	descriptor: RenderPassDepthStencilFields,
) {
	return {
		depthLoadOp: mapOptionalLoadOp(descriptor.depthLoadOp),
		depthStoreOp: mapOptionalStoreOp(descriptor.depthStoreOp),
		depthClearValue: descriptor.depthClearValue ?? 0,
		depthReadOnly: !!descriptor.depthReadOnly,
		stencilLoadOp: mapOptionalLoadOp(descriptor.stencilLoadOp),
		stencilStoreOp: mapOptionalStoreOp(descriptor.stencilStoreOp),
		stencilClearValue: descriptor.stencilClearValue ?? 0,
		stencilReadOnly: !!descriptor.stencilReadOnly,
	};
}
