// libElectrobunUI bindings (the native UI core's C ABI).
import { dlopen, FFIType, suffix, type Pointer } from "bun:ffi";
import { existsSync } from "fs";
import { dirname, join } from "path";

const UI_LIB =
	process.platform === "win32" ? "ElectrobunUI.dll" : `libElectrobunUI.${suffix}`;

function candidates(): string[] {
	const out: string[] = [];
	const env = process.env["ELECTROBUN_UI_PATH"];
	if (env) out.push(env);
	out.push(join(process.cwd(), UI_LIB));
	if (process.argv0) out.push(join(dirname(process.argv0), UI_LIB));
	const execDir = dirname(process.execPath);
	out.push(join(execDir, UI_LIB), join(execDir, "..", "MacOS", UI_LIB), join(execDir, "..", "Resources", UI_LIB));
	return out;
}

const u32 = FFIType.u32;
const f32 = FFIType.f32;
const f64 = FFIType.f64;
const ptr = FFIType.ptr;
const usize = FFIType.u64;
const bool = FFIType.bool;
const u8 = FFIType.u8;
const v = FFIType.void;

export const uiSymbols = {
	ebui_create: { args: [], returns: u32 },
	ebui_destroy: { args: [u32], returns: v },
	ebui_body: { args: [u32], returns: u32 },
	ebui_bind_client_id: { args: [u32, u32, u32], returns: v },
	ebui_resolve: { args: [u32, u32], returns: u32 },
	ebui_apply: { args: [u32, ptr, usize], returns: u32 },
	ebui_event_type: { args: [ptr, usize], returns: u8 },
	ebui_poll_events: { args: [u32, ptr, usize], returns: FFIType.u64_fast },
	ebui_pending_events: { args: [u32], returns: FFIType.u64_fast },
	ebui_set_wakeup: { args: [u32, FFIType.function, ptr], returns: v },
	ebui_add_stylesheet: { args: [u32, ptr, usize], returns: FFIType.u64_fast },
	ebui_remove_stylesheet: { args: [u32, usize], returns: v },
	ebui_get_value: { args: [u32, u32, ptr], returns: ptr },
	ebui_get_checked: { args: [u32, u32], returns: bool },
	ebui_get_rect: { args: [u32, u32, ptr], returns: bool },
	ebui_watch_rect: { args: [u32, u32, bool], returns: bool },
	ebui_focus: { args: [u32, u32], returns: v },
	ebui_scroll_into_view: { args: [u32, u32], returns: v },
	ebui_set_dark: { args: [u32, bool], returns: v },
	ebui_attach_wgpu_view: { args: [u32, ptr, ptr], returns: bool },
	ebui_detach_view: { args: [u32], returns: v },
	ebui_serialize: { args: [u32, u32, ptr], returns: ptr },
	ebui_append_html: { args: [u32, u32, ptr, usize], returns: bool },
	// reactive scopes / templates
	ebui_scope_create: { args: [u32, u32], returns: u32 },
	ebui_scope_set_number: { args: [u32, u32, ptr, usize, f64], returns: u32 },
	ebui_scope_set_bool: { args: [u32, u32, ptr, usize, bool], returns: u32 },
	ebui_scope_set_string: { args: [u32, u32, ptr, usize, ptr, usize], returns: u32 },
	ebui_scope_set_handler: { args: [u32, u32, ptr, usize], returns: bool },
	ebui_signal_set_number: { args: [u32, u32, f64], returns: v },
	ebui_signal_set_string: { args: [u32, u32, ptr, usize], returns: v },
	ebui_signal_set_bool: { args: [u32, u32, bool], returns: v },
	ebui_template_compile: { args: [u32, ptr, usize], returns: u32 },
	ebui_template_mount: { args: [u32, u32, u32, u32, u32], returns: u32 },
	ebui_pointer: { args: [u32, u8, f32, f32, u8, u8], returns: v },
	ebui_wheel: { args: [u32, f32, f32, f32, f32, u8], returns: v },
	ebui_key: { args: [u32, bool, ptr, usize, u8], returns: v },
	ebui_text_input: { args: [u32, ptr, usize], returns: v },
	ebui_use_components: { args: [u32], returns: FFIType.u64_fast },
	ebui_host_frames: { args: [u32], returns: FFIType.u64_fast },
	ebui_request_capture: { args: [u32], returns: v },
	ebui_capture_ready: { args: [u32], returns: bool },
	ebui_capture_pixel: { args: [u32, f32, f32, ptr], returns: bool },
	ebui_a11y_dump: { args: [u32, ptr], returns: ptr },
} as const;

type UiLib = ReturnType<typeof dlopen<typeof uiSymbols>>;
let lib: UiLib | null = null;
let loadError: unknown = null;

export function uiLib(): UiLib["symbols"] {
	if (lib) return lib.symbols;
	for (const path of candidates()) {
		if (!existsSync(path)) continue;
		try {
			lib = dlopen(path, uiSymbols);
			return lib.symbols;
		} catch (e) {
			loadError = e;
		}
	}
	throw new Error(
		`electrobun native UI: could not load ${UI_LIB}` + (loadError ? ` (${String(loadError)})` : "") +
			". Set ELECTROBUN_UI_PATH or bundle the UI library with the app.",
	);
}

export function isNativeUIAvailable(): boolean {
	try {
		uiLib();
		return true;
	} catch {
		return false;
	}
}

export type { Pointer };
