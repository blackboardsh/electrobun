import { FFIType, dlopen, suffix, CString } from "bun:ffi";

const toCString = (str: string) => Buffer.from(`${str}\0`, 'utf8');

const path = `libwebview.${suffix}`;

const lib = dlopen(path, {
	createWebView: {
		args: [FFIType.ptr], // Use ptr for a pointer to a buffer
		returns: FFIType.void,
	},
});

const url = "https://eggbun.sh";
lib.symbols.createWebView(toCString(url));
