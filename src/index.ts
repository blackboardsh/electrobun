// import { FFIType, dlopen, suffix, CString } from "bun:ffi";

const toCString = (str: string) => Buffer.from(`${str}\0`, "utf8");

// const path = `libwebview.${suffix}`;

// const lib = dlopen(path, {
// 	createWebView: {
// 		args: [FFIType.ptr], // Use ptr for a pointer to a buffer
// 		returns: FFIType.void,
// 	},
// });

// const url = "https://eggbun.sh";
// lib.symbols.createWebView(toCString(url));

import { FFIType, dlopen } from "bun:ffi";

const path = "libs/zig/zig-out/lib/libwebview.dylib"; // Adjust the path and filename as needed
const lib = dlopen(path, {
	// create_webview: {
	// 	args: [FFIType.cstring],
	// 	returns: FFIType.void,
	// },
	createWindow: {
		args: [],
		returns: FFIType.ptr,
	},
	startEventLoop: {
		args: [],
		returns: FFIType.void,
	}
});

// lib.symbols.create_webview(toCString("https://www.example.com"));

setTimeout(() => {
	// start the event loop asap after loading without blocking the main thread
	lib.symbols.startEventLoop()
}, 0)


const createWindow = (url: string): number => {
	console.time('createWindow')
	const rawWindowPointer = lib.symbols.createWindow();

	console.timeEnd('createWindow')

	

	// todo (yoav): this should return a window class, that includes the id (raw pointer or other) and the ability to call methods on it
	return rawWindowPointer;
}

const windowId = createWindow('https://eggbun.sh');
const windowId2 = createWindow('https://eggbun.sh');
console.log('after event loop started in js: windowId: ', windowId, windowId2)






/**
 * 
FFIType	C Type	Aliases
cstring	char*	
function	(void*)(*)()	fn, callback
ptr	void*	pointer, void*, char*
i8	int8_t	int8_t
i16	int16_t	int16_t
i32	int32_t	int32_t, int
i64	int64_t	int64_t
i64_fast	int64_t	
u8	uint8_t	uint8_t
u16	uint16_t	uint16_t
u32	uint32_t	uint32_t
u64	uint64_t	uint64_t
u64_fast	uint64_t	
f32	float	float
f64	double	double
bool	bool	
char	char	
 * 
 */