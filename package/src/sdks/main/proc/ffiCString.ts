import { CString, type Pointer } from "bun:ffi";

/**
 * Bun 1.4 decodes `FFIType.cstring` callback arguments to JavaScript strings.
 * Cottontail and earlier Bun releases expose the same arguments as pointers.
 */
export type FFICStringCallbackValue = string | Pointer | null;

export function ffiCStringToString(value: FFICStringCallbackValue): string {
	if (typeof value === "string") return value;
	return value ? new CString(value).toString() : "";
}
