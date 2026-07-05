package electrobun

/*
#cgo linux LDFLAGS: -ldl
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <dlfcn.h>

extern void electrobunWindowCloseHandler(uint32_t);
extern void electrobunWindowMoveHandler(uint32_t, double, double);
extern void electrobunWindowResizeHandler(uint32_t, double, double, double, double);
extern void electrobunWindowFocusHandler(uint32_t);
extern void electrobunWindowBlurHandler(uint32_t);
extern void electrobunWindowKeyHandler(uint32_t, uint32_t, uint32_t, uint32_t, uint32_t);
extern uint32_t electrobunDecideNavigationHandler(uint32_t, const char*);
extern void electrobunWebviewEventHandler(uint32_t, const char*, const char*);
extern void electrobunWebviewEventBridgeHandler(uint32_t, const char*);
extern void electrobunWebviewHostBridgeHandler(uint32_t, const char*);
extern void electrobunWebviewInternalBridgeHandler(uint32_t, const char*);
extern void electrobunStatusItemHandler(uint32_t, const char*);
extern void electrobunGlobalShortcutHandler(const char*);
extern void electrobunURLOpenHandler(const char*);
extern void electrobunAppReopenHandler(void);
extern void electrobunQuitRequestedHandler(void);

typedef void (*eb_window_close_cb)(uint32_t);
typedef void (*eb_window_move_cb)(uint32_t, double, double);
typedef void (*eb_window_resize_cb)(uint32_t, double, double, double, double);
typedef void (*eb_window_focus_cb)(uint32_t);
typedef void (*eb_window_blur_cb)(uint32_t);
typedef void (*eb_window_key_cb)(uint32_t, uint32_t, uint32_t, uint32_t, uint32_t);
typedef uint32_t (*eb_decide_navigation_cb)(uint32_t, const char*);
typedef void (*eb_webview_event_cb)(uint32_t, const char*, const char*);
typedef void (*eb_webview_post_message_cb)(uint32_t, const char*);
typedef void (*eb_status_item_cb)(uint32_t, const char*);
typedef void (*eb_global_shortcut_cb)(const char*);
typedef void (*eb_url_open_cb)(const char*);
typedef void (*eb_app_reopen_cb)(void);
typedef void (*eb_quit_requested_cb)(void);

static void eb_window_close(uint32_t id) { electrobunWindowCloseHandler(id); }
static void eb_window_move(uint32_t id, double x, double y) { electrobunWindowMoveHandler(id, x, y); }
static void eb_window_resize(uint32_t id, double x, double y, double w, double h) { electrobunWindowResizeHandler(id, x, y, w, h); }
static void eb_window_focus(uint32_t id) { electrobunWindowFocusHandler(id); }
static void eb_window_blur(uint32_t id) { electrobunWindowBlurHandler(id); }
static void eb_window_key(uint32_t id, uint32_t key, uint32_t modifiers, uint32_t event_type, uint32_t characters) { electrobunWindowKeyHandler(id, key, modifiers, event_type, characters); }
static uint32_t eb_decide_navigation(uint32_t id, const char* url) { return electrobunDecideNavigationHandler(id, url); }
static void eb_webview_event(uint32_t id, const char* event_name, const char* detail) { electrobunWebviewEventHandler(id, event_name, detail); }
static void eb_webview_event_bridge(uint32_t id, const char* message) { electrobunWebviewEventBridgeHandler(id, message); }
static void eb_webview_host_bridge(uint32_t id, const char* message) { electrobunWebviewHostBridgeHandler(id, message); }
static void eb_webview_internal_bridge(uint32_t id, const char* message) { electrobunWebviewInternalBridgeHandler(id, message); }
static void eb_status_item(uint32_t id, const char* message) { electrobunStatusItemHandler(id, message); }
static void eb_global_shortcut(const char* accelerator) { electrobunGlobalShortcutHandler(accelerator); }
static void eb_url_open(const char* url) { electrobunURLOpenHandler(url); }
static void eb_app_reopen(void) { electrobunAppReopenHandler(); }
static void eb_quit_requested(void) { electrobunQuitRequestedHandler(); }

static void* eb_dlopen(const char* path) { return dlopen(path, RTLD_NOW | RTLD_LOCAL); }
static void* eb_dlsym(void* handle, const char* name) { return dlsym(handle, name); }
static const char* eb_dlerror(void) { return dlerror(); }

typedef const char* (*eb_last_error_fn)(void);
static const char* eb_call_last_error(void* fn) { return ((eb_last_error_fn)fn)(); }

typedef int (*eb_run_main_thread_fn)(const char*, const char*, const char*, int);
static int eb_call_run_main_thread(void* fn, const char* identifier, const char* name, const char* channel, int argc) {
	return ((eb_run_main_thread_fn)fn)(identifier, name, channel, argc);
}

typedef bool (*eb_configure_webview_runtime_fn)(uint32_t, const char*, const char*);
static bool eb_call_configure_webview_runtime(void* fn, uint32_t rpc_port, const char* full_preload, const char* sandboxed_preload) {
	return ((eb_configure_webview_runtime_fn)fn)(rpc_port, full_preload, sandboxed_preload);
}

typedef uint32_t (*eb_get_window_style_fn)(bool, bool, bool, bool, bool, bool, bool, bool, bool, bool, bool, bool);
static uint32_t eb_call_get_window_style(void* fn, bool borderless, bool titled, bool closable, bool miniaturizable, bool resizable, bool unified_title_and_toolbar, bool full_screen, bool full_size_content_view, bool utility_window, bool doc_modal_window, bool nonactivating_panel, bool hud_window) {
	return ((eb_get_window_style_fn)fn)(borderless, titled, closable, miniaturizable, resizable, unified_title_and_toolbar, full_screen, full_size_content_view, utility_window, doc_modal_window, nonactivating_panel, hud_window);
}

typedef uint32_t (*eb_create_window_fn)(double, double, double, double, uint32_t, const char*, bool, const char*, bool, bool, double, double, eb_window_close_cb, eb_window_move_cb, eb_window_resize_cb, eb_window_focus_cb, eb_window_blur_cb, eb_window_key_cb);
static uint32_t eb_call_create_window(void* fn, double x, double y, double width, double height, uint32_t style, const char* title_bar_style, bool transparent, const char* title, bool hidden, bool activate, double traffic_x, double traffic_y, bool close_enabled, bool move_enabled, bool resize_enabled, bool focus_enabled, bool blur_enabled, bool key_enabled) {
	return ((eb_create_window_fn)fn)(x, y, width, height, style, title_bar_style, transparent, title, hidden, activate, traffic_x, traffic_y, close_enabled ? eb_window_close : 0, move_enabled ? eb_window_move : 0, resize_enabled ? eb_window_resize : 0, focus_enabled ? eb_window_focus : 0, blur_enabled ? eb_window_blur : 0, key_enabled ? eb_window_key : 0);
}

typedef uint32_t (*eb_create_webview_fn)(uint32_t, uint32_t, const char*, const char*, double, double, double, double, bool, const char*, eb_decide_navigation_cb, eb_webview_event_cb, eb_webview_post_message_cb, eb_webview_post_message_cb, eb_webview_post_message_cb, const char*, const char*, const char*, bool, bool, bool);
static uint32_t eb_call_create_webview(void* fn, uint32_t window_id, uint32_t host_webview_id, const char* renderer, const char* url, double x, double y, double width, double height, bool auto_resize, const char* partition, bool decide_enabled, bool event_enabled, bool event_bridge_enabled, bool host_bridge_enabled, bool internal_bridge_enabled, const char* secret_key, const char* preload, const char* views_root, bool sandbox, bool start_transparent, bool start_passthrough) {
	return ((eb_create_webview_fn)fn)(window_id, host_webview_id, renderer, url, x, y, width, height, auto_resize, partition, decide_enabled ? eb_decide_navigation : 0, event_enabled ? eb_webview_event : 0, event_bridge_enabled ? eb_webview_event_bridge : 0, host_bridge_enabled ? eb_webview_host_bridge : 0, internal_bridge_enabled ? eb_webview_internal_bridge : 0, secret_key, preload, views_root, sandbox, start_transparent, start_passthrough);
}

typedef uint32_t (*eb_create_wgpu_view_fn)(uint32_t, double, double, double, double, bool, bool, bool);
static uint32_t eb_call_create_wgpu_view(void* fn, uint32_t window_id, double x, double y, double width, double height, bool transparent, bool passthrough, bool hidden) {
	return ((eb_create_wgpu_view_fn)fn)(window_id, x, y, width, height, transparent, passthrough, hidden);
}

typedef void (*eb_u32_fn)(uint32_t);
static void eb_call_u32(void* fn, uint32_t value) { ((eb_u32_fn)fn)(value); }

typedef bool (*eb_u32_bool_ret_fn)(uint32_t);
static bool eb_call_u32_bool_ret(void* fn, uint32_t value) { return ((eb_u32_bool_ret_fn)fn)(value); }

typedef void (*eb_u32_bool_fn)(uint32_t, bool);
static void eb_call_u32_bool(void* fn, uint32_t value, bool flag) { ((eb_u32_bool_fn)fn)(value, flag); }

typedef void (*eb_bool_fn)(bool);
static void eb_call_bool(void* fn, bool flag) { ((eb_bool_fn)fn)(flag); }

typedef bool (*eb_bool_ret_fn)(void);
static bool eb_call_bool_ret(void* fn) { return ((eb_bool_ret_fn)fn)(); }

typedef void (*eb_u32_string_fn)(uint32_t, const char*);
static void eb_call_u32_string(void* fn, uint32_t value, const char* text) { ((eb_u32_string_fn)fn)(value, text); }

typedef void (*eb_u32_string_bool_bool_fn)(uint32_t, const char*, bool, bool);
static void eb_call_u32_string_bool_bool(void* fn, uint32_t value, const char* text, bool a, bool b) { ((eb_u32_string_bool_bool_fn)fn)(value, text, a, b); }

typedef void (*eb_u32_f64_f64_fn)(uint32_t, double, double);
static void eb_call_u32_f64_f64(void* fn, uint32_t value, double x, double y) { ((eb_u32_f64_f64_fn)fn)(value, x, y); }

typedef void (*eb_u32_f64_fn)(uint32_t, double);
static void eb_call_u32_f64(void* fn, uint32_t value, double number) { ((eb_u32_f64_fn)fn)(value, number); }

typedef double (*eb_u32_f64_ret_fn)(uint32_t);
static double eb_call_u32_f64_ret(void* fn, uint32_t value) { return ((eb_u32_f64_ret_fn)fn)(value); }

typedef void (*eb_u32_f64_f64_f64_f64_fn)(uint32_t, double, double, double, double);
static void eb_call_u32_f64_f64_f64_f64(void* fn, uint32_t value, double x, double y, double width, double height) { ((eb_u32_f64_f64_f64_f64_fn)fn)(value, x, y, width, height); }

typedef void (*eb_get_window_frame_fn)(uint32_t, double*, double*, double*, double*);
static void eb_call_get_window_frame(void* fn, uint32_t value, double* x, double* y, double* width, double* height) { ((eb_get_window_frame_fn)fn)(value, x, y, width, height); }

typedef void (*eb_resize_webview_fn)(uint32_t, double, double, double, double, const char*);
static void eb_call_resize_webview(void* fn, uint32_t value, double x, double y, double width, double height, const char* masks_json) { ((eb_resize_webview_fn)fn)(value, x, y, width, height, masks_json); }

typedef bool (*eb_send_host_message_fn)(uint32_t, const char*);
static bool eb_call_send_host_message(void* fn, uint32_t webview_id, const char* message_json) { return ((eb_send_host_message_fn)fn)(webview_id, message_json); }

typedef char* (*eb_pop_host_message_fn)(uint32_t*);
static char* eb_call_pop_host_message(void* fn, uint32_t* webview_id) { return ((eb_pop_host_message_fn)fn)(webview_id); }

typedef void (*eb_free_core_string_fn)(char*);
static void eb_call_free_core_string(void* fn, char* value) { ((eb_free_core_string_fn)fn)(value); }

typedef uint32_t (*eb_create_tray_fn)(const char*, const char*, bool, uint32_t, uint32_t, eb_status_item_cb);
static uint32_t eb_call_create_tray(void* fn, const char* title, const char* image, bool is_template, uint32_t width, uint32_t height, bool handler_enabled) {
	return ((eb_create_tray_fn)fn)(title, image, is_template, width, height, handler_enabled ? eb_status_item : 0);
}

typedef bool (*eb_show_tray_fn)(uint32_t);
static bool eb_call_show_tray(void* fn, uint32_t tray_id) { return ((eb_show_tray_fn)fn)(tray_id); }

typedef char* (*eb_string_ret_fn)(void);
static char* eb_call_string_ret(void* fn) { return ((eb_string_ret_fn)fn)(); }

typedef const char* (*eb_u32_const_string_ret_fn)(uint32_t);
static const char* eb_call_u32_const_string_ret(void* fn, uint32_t value) { return ((eb_u32_const_string_ret_fn)fn)(value); }

typedef bool (*eb_string_bool_ret_fn)(const char*);
static bool eb_call_string_bool_ret(void* fn, const char* value) { return ((eb_string_bool_ret_fn)fn)(value); }

typedef void (*eb_string_fn)(const char*);
static void eb_call_string(void* fn, const char* value) { ((eb_string_fn)fn)(value); }

typedef void (*eb_notification_fn)(const char*, const char*, const char*, bool);
static void eb_call_notification(void* fn, const char* title, const char* body, const char* subtitle, bool silent) { ((eb_notification_fn)fn)(title, body, subtitle, silent); }

typedef void (*eb_menu_fn)(const char*, eb_status_item_cb);
static void eb_call_menu(void* fn, const char* menu_json, bool handler_enabled) { ((eb_menu_fn)fn)(menu_json, handler_enabled ? eb_status_item : 0); }

typedef char* (*eb_open_file_dialog_fn)(const char*, const char*, int, int, int);
static char* eb_call_open_file_dialog(void* fn, const char* starting_folder, const char* allowed_file_types, int can_choose_files, int can_choose_directory, int allows_multiple_selection) {
	return ((eb_open_file_dialog_fn)fn)(starting_folder, allowed_file_types, can_choose_files, can_choose_directory, allows_multiple_selection);
}

typedef int (*eb_show_message_box_fn)(const char*, const char*, const char*, const char*, const char*, int, int);
static int eb_call_show_message_box(void* fn, const char* box_type, const char* title, const char* message, const char* detail, const char* buttons, int default_id, int cancel_id) {
	return ((eb_show_message_box_fn)fn)(box_type, title, message, detail, buttons, default_id, cancel_id);
}

typedef void (*eb_set_global_shortcut_callback_fn)(eb_global_shortcut_cb);
static void eb_call_set_global_shortcut_callback(void* fn, bool enabled) { ((eb_set_global_shortcut_callback_fn)fn)(enabled ? eb_global_shortcut : 0); }

typedef bool (*eb_string_string_bool_ret_fn)(const char*, const char*);
static bool eb_call_string_string_bool_ret(void* fn, const char* a, const char* b) { return ((eb_string_string_bool_ret_fn)fn)(a, b); }

typedef char* (*eb_string_string_ret_fn)(const char*, const char*);
static char* eb_call_string_string_ret(void* fn, const char* a, const char* b) { return ((eb_string_string_ret_fn)fn)(a, b); }

typedef bool (*eb_string_string_string_bool_ret_fn)(const char*, const char*, const char*);
static bool eb_call_string_string_string_bool_ret(void* fn, const char* a, const char* b, const char* c) { return ((eb_string_string_string_bool_ret_fn)fn)(a, b, c); }

typedef void (*eb_string_string_fn)(const char*, const char*);
static void eb_call_string_string(void* fn, const char* a, const char* b) { ((eb_string_string_fn)fn)(a, b); }

typedef void (*eb_set_url_open_handler_fn)(eb_url_open_cb);
static void eb_call_set_url_open_handler(void* fn, bool enabled) { ((eb_set_url_open_handler_fn)fn)(enabled ? eb_url_open : 0); }

typedef void (*eb_set_app_reopen_handler_fn)(eb_app_reopen_cb);
static void eb_call_set_app_reopen_handler(void* fn, bool enabled) { ((eb_set_app_reopen_handler_fn)fn)(enabled ? eb_app_reopen : 0); }

typedef void (*eb_set_quit_requested_handler_fn)(eb_quit_requested_cb);
static void eb_call_set_quit_requested_handler(void* fn, bool enabled) { ((eb_set_quit_requested_handler_fn)fn)(enabled ? eb_quit_requested : 0); }

typedef void (*eb_void_fn)(void);
static void eb_call_void(void* fn) { ((eb_void_fn)fn)(); }

typedef void (*eb_int_fn)(int);
static void eb_call_int(void* fn, int value) { ((eb_int_fn)fn)(value); }

typedef void* (*eb_u32_ptr_ret_fn)(uint32_t);
static void* eb_call_u32_ptr_ret(void* fn, uint32_t value) { return ((eb_u32_ptr_ret_fn)fn)(value); }

typedef void* (*eb_ptr_ret_fn)(void*);
static void* eb_call_ptr_ret(void* fn, void* value) { return ((eb_ptr_ret_fn)fn)(value); }

typedef void* (*eb_ptr_ptr_ptr_ret_fn)(void*, void*);
static void* eb_call_ptr_ptr_ptr_ret(void* fn, void* a, void* b) { return ((eb_ptr_ptr_ptr_ret_fn)fn)(a, b); }

typedef void (*eb_ptr_ptr_ptr_fn)(void*, void*, void*);
static void eb_call_ptr_ptr_ptr(void* fn, void* a, void* b, void* c) { ((eb_ptr_ptr_ptr_fn)fn)(a, b, c); }

typedef void (*eb_ptr_ptr_fn)(void*, void*);
static void eb_call_ptr_ptr(void* fn, void* a, void* b) { ((eb_ptr_ptr_fn)fn)(a, b); }

typedef int (*eb_ptr_int_ret_fn)(void*);
static int eb_call_ptr_int_ret(void* fn, void* value) { return ((eb_ptr_int_ret_fn)fn)(value); }
*/
import "C"

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"unsafe"
)

type Renderer string

const (
	RendererNative Renderer = "native"
	RendererCEF    Renderer = "cef"
)

type AppInfo struct {
	Identifier string
	Name       string
	Channel    string
}

type Rect struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

func NewRect(x, y, width, height float64) Rect {
	return Rect{X: x, Y: y, Width: width, Height: height}
}

type WindowStyle struct {
	Borderless             bool
	Titled                 bool
	Closable               bool
	Miniaturizable         bool
	Resizable              bool
	UnifiedTitleAndToolbar bool
	FullScreen             bool
	FullSizeContentView    bool
	UtilityWindow          bool
	DocModalWindow         bool
	NonactivatingPanel     bool
	HUDWindow              bool
}

func StandardWindowStyle() WindowStyle {
	return WindowStyle{
		Titled:         true,
		Closable:       true,
		Miniaturizable: true,
		Resizable:      true,
	}
}

type WindowCloseHandler func(uint32)
type WindowMoveHandler func(uint32, float64, float64)
type WindowResizeHandler func(uint32, float64, float64, float64, float64)
type WindowFocusHandler func(uint32)
type WindowBlurHandler func(uint32)
type WindowKeyHandler func(uint32, uint32, uint32, uint32, uint32)

type WindowCallbacks struct {
	Close  WindowCloseHandler
	Move   WindowMoveHandler
	Resize WindowResizeHandler
	Focus  WindowFocusHandler
	Blur   WindowBlurHandler
	Key    WindowKeyHandler
}

type TrafficLightOffset struct {
	X float64
	Y float64
}

type WindowOptions struct {
	Title              string
	Frame              Rect
	Style              WindowStyle
	TitleBarStyle      string
	Transparent        bool
	Hidden             bool
	Activate           bool
	TrafficLightOffset TrafficLightOffset
	Callbacks          WindowCallbacks
}

func NewWindowOptions(title string, frame Rect) WindowOptions {
	return WindowOptions{
		Title:         title,
		Frame:         frame,
		Style:         StandardWindowStyle(),
		TitleBarStyle: "default",
		Activate:      true,
	}
}

type DecideNavigationHandler func(uint32, string) uint32
type WebviewEventHandler func(uint32, string, string)
type WebviewPostMessageHandler func(uint32, string)

type WebviewCallbacks struct {
	DecideNavigation DecideNavigationHandler
	Event            WebviewEventHandler
	EventBridge      WebviewPostMessageHandler
	HostBridge       WebviewPostMessageHandler
	BunBridge        WebviewPostMessageHandler
	InternalBridge   WebviewPostMessageHandler
}

type WebviewOptions struct {
	WindowID         uint32
	HostWebviewID    uint32
	Renderer         Renderer
	URL              string
	Frame            Rect
	AutoResize       bool
	Partition        string
	SecretKey        string
	Preload          string
	ViewsRoot        string
	Sandbox          bool
	StartTransparent bool
	StartPassthrough bool
	Callbacks        WebviewCallbacks
}

func NewWebviewOptions(windowID uint32, url string, frame Rect) WebviewOptions {
	return WebviewOptions{
		WindowID:   windowID,
		Renderer:   RendererNative,
		URL:        url,
		Frame:      frame,
		AutoResize: true,
	}
}

type WGPUViewOptions struct {
	WindowID         uint32
	Frame            Rect
	StartTransparent bool
	StartPassthrough bool
	Hidden           bool
}

func NewWGPUViewOptions(windowID uint32, frame Rect) WGPUViewOptions {
	return WGPUViewOptions{WindowID: windowID, Frame: frame}
}

type StatusItemHandler func(uint32, string)

type TrayOptions struct {
	Title      string
	Image      string
	IsTemplate bool
	Width      uint32
	Height     uint32
	Handler    StatusItemHandler
}

type NotificationOptions struct {
	Title    string
	Body     string
	Subtitle string
	Silent   bool
}

type MessageBoxOptions struct {
	BoxType   string
	Title     string
	Message   string
	Detail    string
	Buttons   []string
	DefaultID int
	CancelID  int
}

type OpenFileDialogOptions struct {
	StartingFolder          string
	AllowedFileTypes        string
	CanChooseFiles          bool
	CanChooseDirectory      bool
	AllowsMultipleSelection bool
}

type Point struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type Display struct {
	ID          int64   `json:"id"`
	Bounds      Rect    `json:"bounds"`
	WorkArea    Rect    `json:"workArea"`
	ScaleFactor float64 `json:"scaleFactor"`
	IsPrimary   bool    `json:"isPrimary"`
}

type Paths struct {
	Home      string
	AppData   string
	Config    string
	Cache     string
	Temp      string
	Logs      string
	Documents string
	Downloads string
	Desktop   string
	Pictures  string
	Music     string
	Videos    string
	UserData  string
	UserCache string
	UserLogs  string
}

type BundlePaths struct {
	ExeDir       string
	ResourcesDir string
}

type WgpuAdapterDevice struct {
	Adapter unsafe.Pointer
	Device  unsafe.Pointer
}

type WgpuNative struct {
	lib            unsafe.Pointer
	createInstance unsafe.Pointer
	deviceGetQueue unsafe.Pointer
}

type WgpuContext struct {
	View     unsafe.Pointer
	Instance unsafe.Pointer
	Surface  unsafe.Pointer
	Adapter  unsafe.Pointer
	Device   unsafe.Pointer
}

type Core struct {
	lib     unsafe.Pointer
	symbols map[string]unsafe.Pointer
}

func LoadWgpuNative() (*WgpuNative, error) {
	bundlePaths, err := ResolveBundlePaths()
	if err != nil {
		return nil, err
	}
	libPath := filepath.Join(bundlePaths.ExeDir, wgpuLibraryName())
	pathCString := C.CString(libPath)
	defer C.free(unsafe.Pointer(pathCString))

	lib := C.eb_dlopen(pathCString)
	if lib == nil {
		return nil, fmt.Errorf("failed to open %s: %s", libPath, cConstString(C.eb_dlerror()))
	}

	native := &WgpuNative{lib: lib}
	var ok bool
	native.createInstance, ok = native.Symbol("wgpuCreateInstance")
	if !ok {
		return nil, errors.New("missing WGPU symbol wgpuCreateInstance")
	}
	native.deviceGetQueue, ok = native.Symbol("wgpuDeviceGetQueue")
	if !ok {
		return nil, errors.New("missing WGPU symbol wgpuDeviceGetQueue")
	}
	return native, nil
}

func (n *WgpuNative) Symbol(name string) (unsafe.Pointer, bool) {
	nameCString := C.CString(name)
	defer C.free(unsafe.Pointer(nameCString))
	symbol := C.eb_dlsym(n.lib, nameCString)
	return symbol, symbol != nil
}

func (n *WgpuNative) CreateInstance() (unsafe.Pointer, error) {
	instance := C.eb_call_ptr_ret(n.createInstance, nil)
	if instance == nil {
		return nil, errors.New("failed to create WGPU instance")
	}
	return instance, nil
}

func (n *WgpuNative) DeviceGetQueue(device unsafe.Pointer) (unsafe.Pointer, error) {
	queue := C.eb_call_ptr_ret(n.deviceGetQueue, device)
	if queue == nil {
		return nil, errors.New("failed to get WGPU queue")
	}
	return queue, nil
}

func CreateWgpuContextForView(core *Core, native *WgpuNative, view unsafe.Pointer) (WgpuContext, error) {
	instance, err := native.CreateInstance()
	if err != nil {
		return WgpuContext{}, err
	}
	surface, err := core.WgpuCreateSurfaceForView(instance, view)
	if err != nil {
		return WgpuContext{}, err
	}
	adapterDevice, err := core.WgpuCreateAdapterDeviceMainThread(instance, surface)
	if err != nil {
		return WgpuContext{}, err
	}
	return WgpuContext{
		View:     view,
		Instance: instance,
		Surface:  surface,
		Adapter:  adapterDevice.Adapter,
		Device:   adapterDevice.Device,
	}, nil
}

func CreateWgpuContextForWGPUView(core *Core, native *WgpuNative, viewID uint32) (WgpuContext, error) {
	view, err := core.GetWGPUViewPointer(viewID)
	if err != nil {
		return WgpuContext{}, err
	}
	return CreateWgpuContextForView(core, native, view)
}

func (ctx WgpuContext) GetQueue(native *WgpuNative) (unsafe.Pointer, error) {
	return native.DeviceGetQueue(ctx.Device)
}

func LoadCore() (*Core, error) {
	bundlePaths, err := ResolveBundlePaths()
	if err != nil {
		return nil, err
	}
	libPath := filepath.Join(bundlePaths.ExeDir, coreLibraryName())
	pathCString := C.CString(libPath)
	defer C.free(unsafe.Pointer(pathCString))
	lib := C.eb_dlopen(pathCString)
	if lib == nil {
		return nil, fmt.Errorf("failed to open %s: %s", libPath, cConstString(C.eb_dlerror()))
	}

	core := &Core{lib: lib, symbols: make(map[string]unsafe.Pointer)}
	for _, name := range requiredSymbols {
		nameCString := C.CString(name)
		symbol := C.eb_dlsym(lib, nameCString)
		C.free(unsafe.Pointer(nameCString))
		if symbol == nil {
			return nil, fmt.Errorf("missing core symbol %s", name)
		}
		core.symbols[name] = symbol
	}
	return core, nil
}

var requiredSymbols = []string{
	"electrobun_core_last_error",
	"electrobun_core_run_main_thread",
	"configureWebviewRuntime",
	"getWindowStyle",
	"createWindow",
	"createWebview",
	"createWGPUView",
	"setWindowTitle",
	"minimizeWindow",
	"restoreWindow",
	"isWindowMinimized",
	"maximizeWindow",
	"unmaximizeWindow",
	"isWindowMaximized",
	"setWindowFullScreen",
	"isWindowFullScreen",
	"setWindowAlwaysOnTop",
	"isWindowAlwaysOnTop",
	"setWindowVisibleOnAllWorkspaces",
	"isWindowVisibleOnAllWorkspaces",
	"showWindow",
	"activateWindow",
	"hideWindow",
	"setWindowButtonPosition",
	"setWindowPosition",
	"setWindowSize",
	"setWindowFrame",
	"getWindowFrame",
	"closeWindow",
	"resizeWebview",
	"loadURLInWebView",
	"loadHTMLInWebView",
	"webviewCanGoBack",
	"webviewCanGoForward",
	"webviewGoBack",
	"webviewGoForward",
	"webviewReload",
	"webviewRemove",
	"setWebviewHTMLContent",
	"webviewSetTransparent",
	"webviewSetPassthrough",
	"webviewSetHidden",
	"setWebviewNavigationRules",
	"webviewFindInPage",
	"webviewStopFind",
	"webviewOpenDevTools",
	"webviewCloseDevTools",
	"webviewToggleDevTools",
	"webviewSetPageZoom",
	"webviewGetPageZoom",
	"sendInternalMessageToWebview",
	"setWGPUViewFrame",
	"resizeWGPUView",
	"setWGPUViewTransparent",
	"setWGPUViewPassthrough",
	"setWGPUViewHidden",
	"removeWGPUView",
	"getWGPUViewPointer",
	"getWGPUViewNativeHandle",
	"runWGPUViewTest",
	"toggleWGPUViewTestShader",
	"sendHostMessageToWebviewViaTransport",
	"popNextQueuedHostMessage",
	"freeCoreString",
	"evaluateJavaScriptWithNoCompletion",
	"createTray",
	"showTray",
	"hideTray",
	"setTrayTitle",
	"removeTray",
	"getTrayBounds",
	"setDockIconVisible",
	"isDockIconVisible",
	"getPrimaryDisplay",
	"getAllDisplays",
	"getCursorScreenPoint",
	"moveToTrash",
	"showItemInFolder",
	"openExternal",
	"openPath",
	"showNotification",
	"clipboardReadText",
	"clipboardWriteText",
	"clipboardClear",
	"clipboardAvailableFormats",
	"setApplicationMenu",
	"showContextMenu",
	"openFileDialog",
	"showMessageBox",
	"setGlobalShortcutCallback",
	"registerGlobalShortcut",
	"unregisterGlobalShortcut",
	"unregisterAllGlobalShortcuts",
	"isGlobalShortcutRegistered",
	"sessionGetCookies",
	"sessionSetCookie",
	"sessionRemoveCookie",
	"sessionClearCookies",
	"sessionClearStorageData",
	"setURLOpenHandler",
	"setAppReopenHandler",
	"setQuitRequestedHandler",
	"stopEventLoop",
	"waitForShutdownComplete",
	"forceExit",
	"wgpuCreateSurfaceForView",
	"wgpuCreateAdapterDeviceMainThread",
	"wgpuSurfaceConfigureMainThread",
	"wgpuSurfaceGetCurrentTextureMainThread",
	"wgpuSurfacePresentMainThread",
}

func (c *Core) symbol(name string) unsafe.Pointer {
	return c.symbols[name]
}

func (c *Core) ConfigureWebviewRuntimeFromExecutableDir(bundlePaths BundlePaths, rpcPort uint32) error {
	fullPreload, err := os.ReadFile(filepath.Join(bundlePaths.ResourcesDir, "preload-full.js"))
	if err != nil {
		return err
	}
	sandboxedPreload, err := os.ReadFile(filepath.Join(bundlePaths.ResourcesDir, "preload-sandboxed.js"))
	if err != nil {
		return err
	}
	fullCString, freeFull, err := cString(string(fullPreload), "preload-full.js")
	if err != nil {
		return err
	}
	defer freeFull()
	sandboxedCString, freeSandboxed, err := cString(string(sandboxedPreload), "preload-sandboxed.js")
	if err != nil {
		return err
	}
	defer freeSandboxed()
	ok := C.eb_call_configure_webview_runtime(
		c.symbol("configureWebviewRuntime"),
		C.uint32_t(rpcPort),
		fullCString,
		sandboxedCString,
	)
	if !bool(ok) {
		return errors.New(c.LastError())
	}
	return nil
}

func (c *Core) CreateWindow(options WindowOptions) (uint32, error) {
	title, freeTitle, err := cString(options.Title, "window title")
	if err != nil {
		return 0, err
	}
	defer freeTitle()
	titleBarStyle, freeTitleBarStyle, err := cString(options.TitleBarStyle, "title bar style")
	if err != nil {
		return 0, err
	}
	defer freeTitleBarStyle()

	style := options.Style
	styleMask := C.eb_call_get_window_style(
		c.symbol("getWindowStyle"),
		cbool(style.Borderless),
		cbool(style.Titled),
		cbool(style.Closable),
		cbool(style.Miniaturizable),
		cbool(style.Resizable),
		cbool(style.UnifiedTitleAndToolbar),
		cbool(style.FullScreen),
		cbool(style.FullSizeContentView),
		cbool(style.UtilityWindow),
		cbool(style.DocModalWindow),
		cbool(style.NonactivatingPanel),
		cbool(style.HUDWindow),
	)

	windowID := C.eb_call_create_window(
		c.symbol("createWindow"),
		C.double(options.Frame.X),
		C.double(options.Frame.Y),
		C.double(options.Frame.Width),
		C.double(options.Frame.Height),
		styleMask,
		titleBarStyle,
		cbool(options.Transparent),
		title,
		cbool(options.Hidden),
		cbool(options.Activate),
		C.double(options.TrafficLightOffset.X),
		C.double(options.TrafficLightOffset.Y),
		cbool(options.Callbacks.Close != nil),
		cbool(options.Callbacks.Move != nil),
		cbool(options.Callbacks.Resize != nil),
		cbool(options.Callbacks.Focus != nil),
		cbool(options.Callbacks.Blur != nil),
		cbool(options.Callbacks.Key != nil),
	)
	if windowID == 0 {
		return 0, errors.New(c.LastError())
	}
	registerWindowCallbacks(uint32(windowID), options.Callbacks)
	return uint32(windowID), nil
}

func (c *Core) SetWindowTitle(windowID uint32, title string) error {
	titleCString, freeTitle, err := cString(title, "window title")
	if err != nil {
		return err
	}
	defer freeTitle()
	C.eb_call_u32_string(c.symbol("setWindowTitle"), C.uint32_t(windowID), titleCString)
	return c.ensureLastCallSucceeded()
}

func (c *Core) MinimizeWindow(windowID uint32) error {
	C.eb_call_u32(c.symbol("minimizeWindow"), C.uint32_t(windowID))
	return c.ensureLastCallSucceeded()
}

func (c *Core) RestoreWindow(windowID uint32) error {
	C.eb_call_u32(c.symbol("restoreWindow"), C.uint32_t(windowID))
	return c.ensureLastCallSucceeded()
}

func (c *Core) IsWindowMinimized(windowID uint32) bool {
	return bool(C.eb_call_u32_bool_ret(c.symbol("isWindowMinimized"), C.uint32_t(windowID)))
}

func (c *Core) MaximizeWindow(windowID uint32) error {
	C.eb_call_u32(c.symbol("maximizeWindow"), C.uint32_t(windowID))
	return c.ensureLastCallSucceeded()
}

func (c *Core) UnmaximizeWindow(windowID uint32) error {
	C.eb_call_u32(c.symbol("unmaximizeWindow"), C.uint32_t(windowID))
	return c.ensureLastCallSucceeded()
}

func (c *Core) IsWindowMaximized(windowID uint32) bool {
	return bool(C.eb_call_u32_bool_ret(c.symbol("isWindowMaximized"), C.uint32_t(windowID)))
}

func (c *Core) SetWindowFullScreen(windowID uint32, fullScreen bool) error {
	C.eb_call_u32_bool(c.symbol("setWindowFullScreen"), C.uint32_t(windowID), cbool(fullScreen))
	return c.ensureLastCallSucceeded()
}

func (c *Core) IsWindowFullScreen(windowID uint32) bool {
	return bool(C.eb_call_u32_bool_ret(c.symbol("isWindowFullScreen"), C.uint32_t(windowID)))
}

func (c *Core) SetWindowAlwaysOnTop(windowID uint32, alwaysOnTop bool) error {
	C.eb_call_u32_bool(c.symbol("setWindowAlwaysOnTop"), C.uint32_t(windowID), cbool(alwaysOnTop))
	return c.ensureLastCallSucceeded()
}

func (c *Core) IsWindowAlwaysOnTop(windowID uint32) bool {
	return bool(C.eb_call_u32_bool_ret(c.symbol("isWindowAlwaysOnTop"), C.uint32_t(windowID)))
}

func (c *Core) SetWindowVisibleOnAllWorkspaces(windowID uint32, visible bool) error {
	C.eb_call_u32_bool(c.symbol("setWindowVisibleOnAllWorkspaces"), C.uint32_t(windowID), cbool(visible))
	return c.ensureLastCallSucceeded()
}

func (c *Core) IsWindowVisibleOnAllWorkspaces(windowID uint32) bool {
	return bool(C.eb_call_u32_bool_ret(c.symbol("isWindowVisibleOnAllWorkspaces"), C.uint32_t(windowID)))
}

func (c *Core) ShowWindow(windowID uint32, activate bool) error {
	C.eb_call_u32_bool(c.symbol("showWindow"), C.uint32_t(windowID), cbool(activate))
	return c.ensureLastCallSucceeded()
}

func (c *Core) ActivateWindow(windowID uint32) error {
	C.eb_call_u32(c.symbol("activateWindow"), C.uint32_t(windowID))
	return c.ensureLastCallSucceeded()
}

func (c *Core) HideWindow(windowID uint32) error {
	C.eb_call_u32(c.symbol("hideWindow"), C.uint32_t(windowID))
	return c.ensureLastCallSucceeded()
}

func (c *Core) SetWindowButtonPosition(windowID uint32, x, y float64) error {
	C.eb_call_u32_f64_f64(c.symbol("setWindowButtonPosition"), C.uint32_t(windowID), C.double(x), C.double(y))
	return c.ensureLastCallSucceeded()
}

func (c *Core) SetWindowPosition(windowID uint32, x, y float64) error {
	C.eb_call_u32_f64_f64(c.symbol("setWindowPosition"), C.uint32_t(windowID), C.double(x), C.double(y))
	return c.ensureLastCallSucceeded()
}

func (c *Core) SetWindowSize(windowID uint32, width, height float64) error {
	C.eb_call_u32_f64_f64(c.symbol("setWindowSize"), C.uint32_t(windowID), C.double(width), C.double(height))
	return c.ensureLastCallSucceeded()
}

func (c *Core) SetWindowFrame(windowID uint32, frame Rect) error {
	C.eb_call_u32_f64_f64_f64_f64(c.symbol("setWindowFrame"), C.uint32_t(windowID), C.double(frame.X), C.double(frame.Y), C.double(frame.Width), C.double(frame.Height))
	return c.ensureLastCallSucceeded()
}

func (c *Core) GetWindowFrame(windowID uint32) (Rect, error) {
	var x, y, width, height C.double
	C.eb_call_get_window_frame(c.symbol("getWindowFrame"), C.uint32_t(windowID), &x, &y, &width, &height)
	if err := c.ensureLastCallSucceeded(); err != nil {
		return Rect{}, err
	}
	return NewRect(float64(x), float64(y), float64(width), float64(height)), nil
}

func (c *Core) CloseWindow(windowID uint32) error {
	C.eb_call_u32(c.symbol("closeWindow"), C.uint32_t(windowID))
	return c.ensureLastCallSucceeded()
}

func (c *Core) CreateWebview(options WebviewOptions) (uint32, error) {
	renderer, freeRenderer, err := cString(string(options.Renderer), "renderer")
	if err != nil {
		return 0, err
	}
	defer freeRenderer()
	url, freeURL, err := cString(options.URL, "webview url")
	if err != nil {
		return 0, err
	}
	defer freeURL()
	partition, freePartition, err := cString(options.Partition, "partition")
	if err != nil {
		return 0, err
	}
	defer freePartition()
	secretKey, freeSecretKey, err := cString(options.SecretKey, "secret key")
	if err != nil {
		return 0, err
	}
	defer freeSecretKey()
	preload, freePreload, err := cString(options.Preload, "preload")
	if err != nil {
		return 0, err
	}
	defer freePreload()
	viewsRoot, freeViewsRoot, err := cString(options.ViewsRoot, "views root")
	if err != nil {
		return 0, err
	}
	defer freeViewsRoot()

	hostBridge := options.Callbacks.HostBridge
	if hostBridge == nil {
		hostBridge = options.Callbacks.BunBridge
	}
	webviewID := C.eb_call_create_webview(
		c.symbol("createWebview"),
		C.uint32_t(options.WindowID),
		C.uint32_t(options.HostWebviewID),
		renderer,
		url,
		C.double(options.Frame.X),
		C.double(options.Frame.Y),
		C.double(options.Frame.Width),
		C.double(options.Frame.Height),
		cbool(options.AutoResize),
		partition,
		cbool(options.Callbacks.DecideNavigation != nil),
		cbool(options.Callbacks.Event != nil),
		cbool(options.Callbacks.EventBridge != nil),
		cbool(hostBridge != nil),
		cbool(options.Callbacks.InternalBridge != nil),
		secretKey,
		preload,
		viewsRoot,
		cbool(options.Sandbox),
		cbool(options.StartTransparent),
		cbool(options.StartPassthrough),
	)
	if webviewID == 0 {
		return 0, errors.New(c.LastError())
	}
	callbacks := options.Callbacks
	callbacks.HostBridge = hostBridge
	registerWebviewCallbacks(uint32(webviewID), callbacks)
	return uint32(webviewID), nil
}

func (c *Core) ResizeWebview(webviewID uint32, frame Rect, masksJSON string) error {
	masks, freeMasks, err := cString(masksJSON, "resize masks json")
	if err != nil {
		return err
	}
	defer freeMasks()
	C.eb_call_resize_webview(c.symbol("resizeWebview"), C.uint32_t(webviewID), C.double(frame.X), C.double(frame.Y), C.double(frame.Width), C.double(frame.Height), masks)
	return c.ensureLastCallSucceeded()
}

func (c *Core) LoadURLInWebview(webviewID uint32, url string) error {
	urlCString, freeURL, err := cString(url, "webview url")
	if err != nil {
		return err
	}
	defer freeURL()
	C.eb_call_u32_string(c.symbol("loadURLInWebView"), C.uint32_t(webviewID), urlCString)
	return c.ensureLastCallSucceeded()
}

func (c *Core) LoadHTMLInWebview(webviewID uint32, html string) error {
	htmlCString, freeHTML, err := cString(html, "webview html")
	if err != nil {
		return err
	}
	defer freeHTML()
	C.eb_call_u32_string(c.symbol("loadHTMLInWebView"), C.uint32_t(webviewID), htmlCString)
	return c.ensureLastCallSucceeded()
}

func (c *Core) CanWebviewGoBack(webviewID uint32) bool {
	return bool(C.eb_call_u32_bool_ret(c.symbol("webviewCanGoBack"), C.uint32_t(webviewID)))
}

func (c *Core) CanWebviewGoForward(webviewID uint32) bool {
	return bool(C.eb_call_u32_bool_ret(c.symbol("webviewCanGoForward"), C.uint32_t(webviewID)))
}

func (c *Core) WebviewGoBack(webviewID uint32) error {
	C.eb_call_u32(c.symbol("webviewGoBack"), C.uint32_t(webviewID))
	return c.ensureLastCallSucceeded()
}

func (c *Core) WebviewGoForward(webviewID uint32) error {
	C.eb_call_u32(c.symbol("webviewGoForward"), C.uint32_t(webviewID))
	return c.ensureLastCallSucceeded()
}

func (c *Core) ReloadWebview(webviewID uint32) error {
	C.eb_call_u32(c.symbol("webviewReload"), C.uint32_t(webviewID))
	return c.ensureLastCallSucceeded()
}

func (c *Core) RemoveWebview(webviewID uint32) error {
	C.eb_call_u32(c.symbol("webviewRemove"), C.uint32_t(webviewID))
	forgetWebviewCallbacks(webviewID)
	return c.ensureLastCallSucceeded()
}

func (c *Core) SetWebviewHTMLContent(webviewID uint32, html string) error {
	htmlCString, freeHTML, err := cString(html, "webview html")
	if err != nil {
		return err
	}
	defer freeHTML()
	C.eb_call_u32_string(c.symbol("setWebviewHTMLContent"), C.uint32_t(webviewID), htmlCString)
	return c.ensureLastCallSucceeded()
}

func (c *Core) SetWebviewTransparent(webviewID uint32, transparent bool) error {
	C.eb_call_u32_bool(c.symbol("webviewSetTransparent"), C.uint32_t(webviewID), cbool(transparent))
	return c.ensureLastCallSucceeded()
}

func (c *Core) SetWebviewPassthrough(webviewID uint32, passthrough bool) error {
	C.eb_call_u32_bool(c.symbol("webviewSetPassthrough"), C.uint32_t(webviewID), cbool(passthrough))
	return c.ensureLastCallSucceeded()
}

func (c *Core) SetWebviewHidden(webviewID uint32, hidden bool) error {
	C.eb_call_u32_bool(c.symbol("webviewSetHidden"), C.uint32_t(webviewID), cbool(hidden))
	return c.ensureLastCallSucceeded()
}

func (c *Core) SetWebviewNavigationRules(webviewID uint32, rulesJSON string) error {
	rules, freeRules, err := cString(rulesJSON, "navigation rules json")
	if err != nil {
		return err
	}
	defer freeRules()
	C.eb_call_u32_string(c.symbol("setWebviewNavigationRules"), C.uint32_t(webviewID), rules)
	return c.ensureLastCallSucceeded()
}

func (c *Core) WebviewFindInPage(webviewID uint32, text string, forward, matchCase bool) error {
	textCString, freeText, err := cString(text, "find text")
	if err != nil {
		return err
	}
	defer freeText()
	C.eb_call_u32_string_bool_bool(c.symbol("webviewFindInPage"), C.uint32_t(webviewID), textCString, cbool(forward), cbool(matchCase))
	return c.ensureLastCallSucceeded()
}

func (c *Core) WebviewStopFind(webviewID uint32) error {
	C.eb_call_u32(c.symbol("webviewStopFind"), C.uint32_t(webviewID))
	return c.ensureLastCallSucceeded()
}

func (c *Core) OpenWebviewDevtools(webviewID uint32) error {
	C.eb_call_u32(c.symbol("webviewOpenDevTools"), C.uint32_t(webviewID))
	return c.ensureLastCallSucceeded()
}

func (c *Core) CloseWebviewDevtools(webviewID uint32) error {
	C.eb_call_u32(c.symbol("webviewCloseDevTools"), C.uint32_t(webviewID))
	return c.ensureLastCallSucceeded()
}

func (c *Core) ToggleWebviewDevtools(webviewID uint32) error {
	C.eb_call_u32(c.symbol("webviewToggleDevTools"), C.uint32_t(webviewID))
	return c.ensureLastCallSucceeded()
}

func (c *Core) SetWebviewPageZoom(webviewID uint32, zoomLevel float64) error {
	C.eb_call_u32_f64(c.symbol("webviewSetPageZoom"), C.uint32_t(webviewID), C.double(zoomLevel))
	return c.ensureLastCallSucceeded()
}

func (c *Core) GetWebviewPageZoom(webviewID uint32) float64 {
	return float64(C.eb_call_u32_f64_ret(c.symbol("webviewGetPageZoom"), C.uint32_t(webviewID)))
}

func (c *Core) SendInternalMessageToWebviewJSON(webviewID uint32, messageJSON string) error {
	message, freeMessage, err := cString(messageJSON, "internal message")
	if err != nil {
		return err
	}
	defer freeMessage()
	ok := C.eb_call_send_host_message(c.symbol("sendInternalMessageToWebview"), C.uint32_t(webviewID), message)
	if !bool(ok) {
		return errors.New(c.LastError())
	}
	return nil
}

func (c *Core) CreateWGPUView(options WGPUViewOptions) (uint32, error) {
	viewID := C.eb_call_create_wgpu_view(
		c.symbol("createWGPUView"),
		C.uint32_t(options.WindowID),
		C.double(options.Frame.X),
		C.double(options.Frame.Y),
		C.double(options.Frame.Width),
		C.double(options.Frame.Height),
		cbool(options.StartTransparent),
		cbool(options.StartPassthrough),
		cbool(options.Hidden),
	)
	if viewID == 0 {
		return 0, errors.New(c.LastError())
	}
	return uint32(viewID), nil
}

func (c *Core) SetWGPUViewFrame(viewID uint32, frame Rect) error {
	C.eb_call_u32_f64_f64_f64_f64(c.symbol("setWGPUViewFrame"), C.uint32_t(viewID), C.double(frame.X), C.double(frame.Y), C.double(frame.Width), C.double(frame.Height))
	return c.ensureLastCallSucceeded()
}

func (c *Core) ResizeWGPUView(viewID uint32, frame Rect, masksJSON string) error {
	masks, freeMasks, err := cString(masksJSON, "resize masks json")
	if err != nil {
		return err
	}
	defer freeMasks()
	C.eb_call_resize_webview(c.symbol("resizeWGPUView"), C.uint32_t(viewID), C.double(frame.X), C.double(frame.Y), C.double(frame.Width), C.double(frame.Height), masks)
	return c.ensureLastCallSucceeded()
}

func (c *Core) SetWGPUViewTransparent(viewID uint32, transparent bool) error {
	C.eb_call_u32_bool(c.symbol("setWGPUViewTransparent"), C.uint32_t(viewID), cbool(transparent))
	return c.ensureLastCallSucceeded()
}

func (c *Core) SetWGPUViewPassthrough(viewID uint32, passthrough bool) error {
	C.eb_call_u32_bool(c.symbol("setWGPUViewPassthrough"), C.uint32_t(viewID), cbool(passthrough))
	return c.ensureLastCallSucceeded()
}

func (c *Core) SetWGPUViewHidden(viewID uint32, hidden bool) error {
	C.eb_call_u32_bool(c.symbol("setWGPUViewHidden"), C.uint32_t(viewID), cbool(hidden))
	return c.ensureLastCallSucceeded()
}

func (c *Core) RemoveWGPUView(viewID uint32) error {
	C.eb_call_u32(c.symbol("removeWGPUView"), C.uint32_t(viewID))
	return c.ensureLastCallSucceeded()
}

func (c *Core) GetWGPUViewPointer(viewID uint32) (unsafe.Pointer, error) {
	ptr := C.eb_call_u32_ptr_ret(c.symbol("getWGPUViewPointer"), C.uint32_t(viewID))
	if ptr == nil {
		return nil, errors.New(c.LastError())
	}
	return ptr, nil
}

func (c *Core) GetWGPUViewNativeHandle(viewID uint32) (unsafe.Pointer, error) {
	ptr := C.eb_call_u32_ptr_ret(c.symbol("getWGPUViewNativeHandle"), C.uint32_t(viewID))
	if ptr == nil {
		return nil, errors.New(c.LastError())
	}
	return ptr, nil
}

func (c *Core) RunWGPUViewTest(viewID uint32) error {
	C.eb_call_u32(c.symbol("runWGPUViewTest"), C.uint32_t(viewID))
	return c.ensureLastCallSucceeded()
}

func (c *Core) ToggleWGPUViewTestShader(viewID uint32) error {
	C.eb_call_u32(c.symbol("toggleWGPUViewTestShader"), C.uint32_t(viewID))
	return c.ensureLastCallSucceeded()
}

func (c *Core) EvaluateJavaScriptWithNoCompletion(webviewID uint32, script string) error {
	scriptCString, freeScript, err := cString(script, "javascript")
	if err != nil {
		return err
	}
	defer freeScript()
	C.eb_call_u32_string(c.symbol("evaluateJavaScriptWithNoCompletion"), C.uint32_t(webviewID), scriptCString)
	return c.ensureLastCallSucceeded()
}

func (c *Core) SendHostMessageToWebviewJSON(webviewID uint32, messageJSON string) error {
	message, freeMessage, err := cString(messageJSON, "host message")
	if err != nil {
		return err
	}
	defer freeMessage()
	ok := C.eb_call_send_host_message(c.symbol("sendHostMessageToWebviewViaTransport"), C.uint32_t(webviewID), message)
	if !bool(ok) {
		return errors.New(c.LastError())
	}
	return nil
}

func (c *Core) PopNextQueuedHostMessageString() (uint32, string, bool) {
	var webviewID C.uint32_t
	ptr := C.eb_call_pop_host_message(c.symbol("popNextQueuedHostMessage"), &webviewID)
	if ptr == nil {
		return 0, "", false
	}
	message := C.GoString(ptr)
	C.eb_call_free_core_string(c.symbol("freeCoreString"), ptr)
	return uint32(webviewID), message, true
}

func (c *Core) CreateTray(options TrayOptions) (uint32, error) {
	title, freeTitle, err := cString(options.Title, "tray title")
	if err != nil {
		return 0, err
	}
	defer freeTitle()
	image, freeImage, err := cString(options.Image, "tray image")
	if err != nil {
		return 0, err
	}
	defer freeImage()
	setStatusItemHandler(options.Handler)
	trayID := C.eb_call_create_tray(c.symbol("createTray"), title, image, cbool(options.IsTemplate), C.uint32_t(options.Width), C.uint32_t(options.Height), cbool(options.Handler != nil))
	if trayID == 0 {
		return 0, errors.New(c.LastError())
	}
	return uint32(trayID), nil
}

func (c *Core) ShowTray(trayID uint32) error {
	if !bool(C.eb_call_show_tray(c.symbol("showTray"), C.uint32_t(trayID))) {
		return errors.New(c.LastError())
	}
	return nil
}

func (c *Core) HideTray(trayID uint32) error {
	C.eb_call_u32(c.symbol("hideTray"), C.uint32_t(trayID))
	return c.ensureLastCallSucceeded()
}

func (c *Core) SetTrayTitle(trayID uint32, title string) error {
	titleCString, freeTitle, err := cString(title, "tray title")
	if err != nil {
		return err
	}
	defer freeTitle()
	C.eb_call_u32_string(c.symbol("setTrayTitle"), C.uint32_t(trayID), titleCString)
	return c.ensureLastCallSucceeded()
}

func (c *Core) RemoveTray(trayID uint32) error {
	C.eb_call_u32(c.symbol("removeTray"), C.uint32_t(trayID))
	return c.ensureLastCallSucceeded()
}

func (c *Core) GetTrayBounds(trayID uint32) (Rect, error) {
	ptr := C.eb_call_u32_const_string_ret(c.symbol("getTrayBounds"), C.uint32_t(trayID))
	if ptr == nil {
		return Rect{}, errors.New(c.LastError())
	}
	return ParseRectJSON(C.GoString(ptr)), nil
}

func (c *Core) SetDockIconVisible(visible bool) error {
	C.eb_call_bool(c.symbol("setDockIconVisible"), cbool(visible))
	return c.ensureLastCallSucceeded()
}

func (c *Core) IsDockIconVisible() bool {
	return bool(C.eb_call_bool_ret(c.symbol("isDockIconVisible")))
}

func (c *Core) GetPrimaryDisplay() (Display, error) {
	ptr := C.eb_call_string_ret(c.symbol("getPrimaryDisplay"))
	if ptr == nil {
		return Display{}, errors.New(c.LastError())
	}
	jsonValue := C.GoString(ptr)
	C.eb_call_free_core_string(c.symbol("freeCoreString"), ptr)
	return ParseDisplayJSON(jsonValue), nil
}

func (c *Core) GetAllDisplays() ([]Display, error) {
	ptr := C.eb_call_string_ret(c.symbol("getAllDisplays"))
	if ptr == nil {
		return nil, errors.New(c.LastError())
	}
	jsonValue := C.GoString(ptr)
	C.eb_call_free_core_string(c.symbol("freeCoreString"), ptr)
	var displays []Display
	if err := json.Unmarshal([]byte(jsonValue), &displays); err != nil {
		return nil, err
	}
	return displays, nil
}

func (c *Core) GetCursorScreenPoint() (Point, error) {
	ptr := C.eb_call_string_ret(c.symbol("getCursorScreenPoint"))
	if ptr == nil {
		return Point{}, errors.New(c.LastError())
	}
	jsonValue := C.GoString(ptr)
	C.eb_call_free_core_string(c.symbol("freeCoreString"), ptr)
	var point Point
	if err := json.Unmarshal([]byte(jsonValue), &point); err != nil {
		return Point{}, err
	}
	return point, nil
}

func (c *Core) MoveToTrash(path string) (bool, error) {
	pathCString, freePath, err := cString(path, "path")
	if err != nil {
		return false, err
	}
	defer freePath()
	return bool(C.eb_call_string_bool_ret(c.symbol("moveToTrash"), pathCString)), nil
}

func (c *Core) ShowItemInFolder(path string) error {
	pathCString, freePath, err := cString(path, "path")
	if err != nil {
		return err
	}
	defer freePath()
	C.eb_call_string(c.symbol("showItemInFolder"), pathCString)
	return c.ensureLastCallSucceeded()
}

func (c *Core) OpenExternal(url string) (bool, error) {
	urlCString, freeURL, err := cString(url, "url")
	if err != nil {
		return false, err
	}
	defer freeURL()
	return bool(C.eb_call_string_bool_ret(c.symbol("openExternal"), urlCString)), nil
}

func (c *Core) OpenPath(path string) (bool, error) {
	pathCString, freePath, err := cString(path, "path")
	if err != nil {
		return false, err
	}
	defer freePath()
	return bool(C.eb_call_string_bool_ret(c.symbol("openPath"), pathCString)), nil
}

func (c *Core) ShowNotification(options NotificationOptions) error {
	title, freeTitle, err := cString(options.Title, "notification title")
	if err != nil {
		return err
	}
	defer freeTitle()
	body, freeBody, err := cString(options.Body, "notification body")
	if err != nil {
		return err
	}
	defer freeBody()
	subtitle, freeSubtitle, err := cString(options.Subtitle, "notification subtitle")
	if err != nil {
		return err
	}
	defer freeSubtitle()
	C.eb_call_notification(c.symbol("showNotification"), title, body, subtitle, cbool(options.Silent))
	return c.ensureLastCallSucceeded()
}

func (c *Core) ClipboardReadText() (string, bool, error) {
	ptr := C.eb_call_string_ret(c.symbol("clipboardReadText"))
	if ptr == nil {
		return "", false, nil
	}
	text := C.GoString(ptr)
	C.eb_call_free_core_string(c.symbol("freeCoreString"), ptr)
	return text, true, nil
}

func (c *Core) ClipboardWriteText(text string) error {
	textCString, freeText, err := cString(text, "clipboard text")
	if err != nil {
		return err
	}
	defer freeText()
	C.eb_call_string(c.symbol("clipboardWriteText"), textCString)
	return c.ensureLastCallSucceeded()
}

func (c *Core) ClipboardClear() error {
	C.eb_call_void(c.symbol("clipboardClear"))
	return c.ensureLastCallSucceeded()
}

func (c *Core) ClipboardAvailableFormatsCSV() (string, error) {
	ptr := C.eb_call_string_ret(c.symbol("clipboardAvailableFormats"))
	if ptr == nil {
		return "", nil
	}
	formats := C.GoString(ptr)
	C.eb_call_free_core_string(c.symbol("freeCoreString"), ptr)
	return formats, nil
}

func (c *Core) SetApplicationMenuJSON(menuJSON string, handler StatusItemHandler) error {
	menu, freeMenu, err := cString(menuJSON, "application menu json")
	if err != nil {
		return err
	}
	defer freeMenu()
	setStatusItemHandler(handler)
	C.eb_call_menu(c.symbol("setApplicationMenu"), menu, cbool(handler != nil))
	return c.ensureLastCallSucceeded()
}

func (c *Core) ShowContextMenuJSON(menuJSON string, handler StatusItemHandler) error {
	menu, freeMenu, err := cString(menuJSON, "context menu json")
	if err != nil {
		return err
	}
	defer freeMenu()
	setStatusItemHandler(handler)
	C.eb_call_menu(c.symbol("showContextMenu"), menu, cbool(handler != nil))
	return c.ensureLastCallSucceeded()
}

func (c *Core) OpenFileDialog(options OpenFileDialogOptions) (string, error) {
	startingFolder, freeStartingFolder, err := cString(options.StartingFolder, "starting folder")
	if err != nil {
		return "", err
	}
	defer freeStartingFolder()
	allowedFileTypes, freeAllowedFileTypes, err := cString(options.AllowedFileTypes, "allowed file types")
	if err != nil {
		return "", err
	}
	defer freeAllowedFileTypes()
	ptr := C.eb_call_open_file_dialog(
		c.symbol("openFileDialog"),
		startingFolder,
		allowedFileTypes,
		boolInt(options.CanChooseFiles),
		boolInt(options.CanChooseDirectory),
		boolInt(options.AllowsMultipleSelection),
	)
	if ptr == nil {
		return "", nil
	}
	value := C.GoString(ptr)
	C.eb_call_free_core_string(c.symbol("freeCoreString"), ptr)
	return value, nil
}

func (c *Core) ShowMessageBox(options MessageBoxOptions) (int, error) {
	boxType, freeBoxType, err := cString(options.BoxType, "message box type")
	if err != nil {
		return 0, err
	}
	defer freeBoxType()
	title, freeTitle, err := cString(options.Title, "message box title")
	if err != nil {
		return 0, err
	}
	defer freeTitle()
	message, freeMessage, err := cString(options.Message, "message box message")
	if err != nil {
		return 0, err
	}
	defer freeMessage()
	detail, freeDetail, err := cString(options.Detail, "message box detail")
	if err != nil {
		return 0, err
	}
	defer freeDetail()
	buttons, freeButtons, err := cString(strings.Join(options.Buttons, ","), "message box buttons")
	if err != nil {
		return 0, err
	}
	defer freeButtons()
	response := C.eb_call_show_message_box(c.symbol("showMessageBox"), boxType, title, message, detail, buttons, C.int(options.DefaultID), C.int(options.CancelID))
	if err := c.ensureLastCallSucceeded(); err != nil {
		return 0, err
	}
	return int(response), nil
}

func (c *Core) SetGlobalShortcutCallback(handler func(string)) error {
	setGlobalShortcutHandler(handler)
	C.eb_call_set_global_shortcut_callback(c.symbol("setGlobalShortcutCallback"), cbool(handler != nil))
	return c.ensureLastCallSucceeded()
}

func (c *Core) RegisterGlobalShortcut(accelerator string) (bool, error) {
	value, freeValue, err := cString(accelerator, "accelerator")
	if err != nil {
		return false, err
	}
	defer freeValue()
	return bool(C.eb_call_string_bool_ret(c.symbol("registerGlobalShortcut"), value)), nil
}

func (c *Core) UnregisterGlobalShortcut(accelerator string) (bool, error) {
	value, freeValue, err := cString(accelerator, "accelerator")
	if err != nil {
		return false, err
	}
	defer freeValue()
	return bool(C.eb_call_string_bool_ret(c.symbol("unregisterGlobalShortcut"), value)), nil
}

func (c *Core) UnregisterAllGlobalShortcuts() error {
	C.eb_call_void(c.symbol("unregisterAllGlobalShortcuts"))
	return c.ensureLastCallSucceeded()
}

func (c *Core) IsGlobalShortcutRegistered(accelerator string) (bool, error) {
	value, freeValue, err := cString(accelerator, "accelerator")
	if err != nil {
		return false, err
	}
	defer freeValue()
	return bool(C.eb_call_string_bool_ret(c.symbol("isGlobalShortcutRegistered"), value)), nil
}

func (c *Core) SessionGetCookies(partition, filterJSON string) (string, error) {
	partitionCString, freePartition, err := cString(partition, "session partition")
	if err != nil {
		return "", err
	}
	defer freePartition()
	filterCString, freeFilter, err := cString(filterJSON, "cookie filter json")
	if err != nil {
		return "", err
	}
	defer freeFilter()
	ptr := C.eb_call_string_string_ret(c.symbol("sessionGetCookies"), partitionCString, filterCString)
	if ptr == nil {
		return "[]", nil
	}
	value := C.GoString(ptr)
	C.eb_call_free_core_string(c.symbol("freeCoreString"), ptr)
	return value, nil
}

func (c *Core) SessionSetCookie(partition, cookieJSON string) (bool, error) {
	partitionCString, freePartition, err := cString(partition, "session partition")
	if err != nil {
		return false, err
	}
	defer freePartition()
	cookieCString, freeCookie, err := cString(cookieJSON, "cookie json")
	if err != nil {
		return false, err
	}
	defer freeCookie()
	return bool(C.eb_call_string_string_bool_ret(c.symbol("sessionSetCookie"), partitionCString, cookieCString)), nil
}

func (c *Core) SessionRemoveCookie(partition, url, name string) (bool, error) {
	partitionCString, freePartition, err := cString(partition, "session partition")
	if err != nil {
		return false, err
	}
	defer freePartition()
	urlCString, freeURL, err := cString(url, "cookie url")
	if err != nil {
		return false, err
	}
	defer freeURL()
	nameCString, freeName, err := cString(name, "cookie name")
	if err != nil {
		return false, err
	}
	defer freeName()
	return bool(C.eb_call_string_string_string_bool_ret(c.symbol("sessionRemoveCookie"), partitionCString, urlCString, nameCString)), nil
}

func (c *Core) SessionClearCookies(partition string) error {
	partitionCString, freePartition, err := cString(partition, "session partition")
	if err != nil {
		return err
	}
	defer freePartition()
	C.eb_call_string(c.symbol("sessionClearCookies"), partitionCString)
	return c.ensureLastCallSucceeded()
}

func (c *Core) SessionClearStorageData(partition, storageTypesJSON string) error {
	partitionCString, freePartition, err := cString(partition, "session partition")
	if err != nil {
		return err
	}
	defer freePartition()
	storageCString, freeStorage, err := cString(storageTypesJSON, "storage types json")
	if err != nil {
		return err
	}
	defer freeStorage()
	C.eb_call_string_string(c.symbol("sessionClearStorageData"), partitionCString, storageCString)
	return c.ensureLastCallSucceeded()
}

func (c *Core) SetURLOpenHandler(handler func(string)) error {
	setURLOpenHandler(handler)
	C.eb_call_set_url_open_handler(c.symbol("setURLOpenHandler"), cbool(handler != nil))
	return c.ensureLastCallSucceeded()
}

func (c *Core) SetAppReopenHandler(handler func()) error {
	setAppReopenHandler(handler)
	C.eb_call_set_app_reopen_handler(c.symbol("setAppReopenHandler"), cbool(handler != nil))
	return c.ensureLastCallSucceeded()
}

func (c *Core) SetQuitRequestedHandler(handler func()) error {
	setQuitRequestedHandler(handler)
	C.eb_call_set_quit_requested_handler(c.symbol("setQuitRequestedHandler"), cbool(handler != nil))
	return c.ensureLastCallSucceeded()
}

func (c *Core) StopEventLoop() error {
	C.eb_call_void(c.symbol("stopEventLoop"))
	return c.ensureLastCallSucceeded()
}

func (c *Core) WaitForShutdownComplete(timeoutMS int) error {
	C.eb_call_int(c.symbol("waitForShutdownComplete"), C.int(timeoutMS))
	return c.ensureLastCallSucceeded()
}

func (c *Core) ForceExit(code int) {
	C.eb_call_int(c.symbol("forceExit"), C.int(code))
	os.Exit(code)
}

func (c *Core) WgpuCreateSurfaceForView(instance, viewPtr unsafe.Pointer) (unsafe.Pointer, error) {
	ptr := C.eb_call_ptr_ptr_ptr_ret(c.symbol("wgpuCreateSurfaceForView"), instance, viewPtr)
	if ptr == nil {
		return nil, errors.New(c.LastError())
	}
	return ptr, nil
}

func (c *Core) WgpuCreateAdapterDeviceMainThread(instance, surface unsafe.Pointer) (WgpuAdapterDevice, error) {
	buffer := C.calloc(2, C.size_t(unsafe.Sizeof(uintptr(0))))
	if buffer == nil {
		return WgpuAdapterDevice{}, errors.New("failed to allocate WGPU adapter/device buffer")
	}
	defer C.free(buffer)
	C.eb_call_ptr_ptr_ptr(c.symbol("wgpuCreateAdapterDeviceMainThread"), instance, surface, buffer)
	if err := c.ensureLastCallSucceeded(); err != nil {
		return WgpuAdapterDevice{}, err
	}
	values := (*[2]unsafe.Pointer)(buffer)
	adapterDevice := WgpuAdapterDevice{Adapter: values[0], Device: values[1]}
	if adapterDevice.Adapter == nil || adapterDevice.Device == nil {
		return WgpuAdapterDevice{}, errors.New("missing WGPU adapter or device")
	}
	return adapterDevice, nil
}

func (c *Core) WgpuSurfaceConfigureMainThread(surface, config unsafe.Pointer) error {
	C.eb_call_ptr_ptr(c.symbol("wgpuSurfaceConfigureMainThread"), surface, config)
	return c.ensureLastCallSucceeded()
}

func (c *Core) WgpuSurfaceGetCurrentTextureMainThread(surface, surfaceTexture unsafe.Pointer) error {
	C.eb_call_ptr_ptr(c.symbol("wgpuSurfaceGetCurrentTextureMainThread"), surface, surfaceTexture)
	return c.ensureLastCallSucceeded()
}

func (c *Core) WgpuSurfacePresentMainThread(surface unsafe.Pointer) (int, error) {
	status := C.eb_call_ptr_int_ret(c.symbol("wgpuSurfacePresentMainThread"), surface)
	if err := c.ensureLastCallSucceeded(); err != nil {
		return 0, err
	}
	return int(status), nil
}

func (c *Core) RunMainThread(appInfo AppInfo) error {
	identifier, freeIdentifier, err := cString(appInfo.Identifier, "app identifier")
	if err != nil {
		return err
	}
	defer freeIdentifier()
	name, freeName, err := cString(appInfo.Name, "app name")
	if err != nil {
		return err
	}
	defer freeName()
	channel, freeChannel, err := cString(appInfo.Channel, "app channel")
	if err != nil {
		return err
	}
	defer freeChannel()
	status := C.eb_call_run_main_thread(c.symbol("electrobun_core_run_main_thread"), identifier, name, channel, 0)
	if status != 0 {
		return errors.New(c.LastError())
	}
	return nil
}

func (c *Core) LastError() string {
	ptr := C.eb_call_last_error(c.symbol("electrobun_core_last_error"))
	return cConstString(ptr)
}

func (c *Core) ensureLastCallSucceeded() error {
	message := c.LastError()
	if message == "" {
		return nil
	}
	return errors.New(message)
}

func ResolveBundlePaths() (BundlePaths, error) {
	exePath, err := os.Executable()
	if err != nil {
		return BundlePaths{}, fmt.Errorf("failed to resolve executable path: %w", err)
	}
	exeDir := filepath.Dir(exePath)
	return BundlePaths{
		ExeDir:       exeDir,
		ResourcesDir: filepath.Clean(filepath.Join(exeDir, "..", "Resources")),
	}, nil
}

func ResolveAppInfoFromBundle(bundlePaths BundlePaths) (AppInfo, error) {
	versionJSON, err := os.ReadFile(filepath.Join(bundlePaths.ResourcesDir, "version.json"))
	if err != nil {
		return AppInfo{}, err
	}
	return AppInfo{
		Identifier: JsonStringField(string(versionJSON), "identifier", "sh.blackboard.electrobun"),
		Name:       JsonStringField(string(versionJSON), "name", "Electrobun"),
		Channel:    JsonStringField(string(versionJSON), "channel", "dev"),
	}, nil
}

func ResolvePaths(appInfo AppInfo) (Paths, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return Paths{}, err
	}
	appData := appDataDir(home)
	config := configDir(home)
	cache := cacheDir(home)
	logs := logsDir(home)
	scoped := appInfo.Identifier
	if scoped == "" {
		scoped = appInfo.Name
	}
	return Paths{
		Home:      home,
		AppData:   appData,
		Config:    config,
		Cache:     cache,
		Temp:      tempDir(),
		Logs:      logs,
		Documents: filepath.Join(home, "Documents"),
		Downloads: filepath.Join(home, "Downloads"),
		Desktop:   filepath.Join(home, "Desktop"),
		Pictures:  filepath.Join(home, "Pictures"),
		Music:     filepath.Join(home, "Music"),
		Videos:    filepath.Join(home, "Videos"),
		UserData:  filepath.Join(appData, scoped),
		UserCache: filepath.Join(cache, scoped),
		UserLogs:  filepath.Join(logs, scoped),
	}, nil
}

func AllowAllNavigation(_ uint32, _ string) uint32 {
	return 1
}

func NoopWebviewEvent(_ uint32, _, _ string) {}

func NoopWebviewPostMessage(_ uint32, _ string) {}

func JsonStringLiteral(value string) string {
	bytes, _ := json.Marshal(value)
	return string(bytes)
}

func JsonStringField(source, key, fallback string) string {
	var obj map[string]json.RawMessage
	if json.Unmarshal([]byte(source), &obj) != nil {
		return fallback
	}
	var value string
	if raw, ok := obj[key]; ok && json.Unmarshal(raw, &value) == nil {
		return value
	}
	return fallback
}

func JsonOptionalStringField(source, key string) (string, bool) {
	var obj map[string]json.RawMessage
	if json.Unmarshal([]byte(source), &obj) != nil {
		return "", false
	}
	var value string
	if raw, ok := obj[key]; ok && json.Unmarshal(raw, &value) == nil {
		return value, true
	}
	return "", false
}

func JsonNumberField(source, key string) (float64, bool) {
	var obj map[string]json.RawMessage
	if json.Unmarshal([]byte(source), &obj) != nil {
		return 0, false
	}
	var value float64
	if raw, ok := obj[key]; ok && json.Unmarshal(raw, &value) == nil {
		return value, true
	}
	return 0, false
}

func JsonBoolField(source, key string) (bool, bool) {
	var obj map[string]json.RawMessage
	if json.Unmarshal([]byte(source), &obj) != nil {
		return false, false
	}
	var value bool
	if raw, ok := obj[key]; ok && json.Unmarshal(raw, &value) == nil {
		return value, true
	}
	return false, false
}

func JsonObjectField(source, key string) (string, bool) {
	var obj map[string]json.RawMessage
	if json.Unmarshal([]byte(source), &obj) != nil {
		return "", false
	}
	if raw, ok := obj[key]; ok && len(raw) > 0 && raw[0] == '{' {
		return string(raw), true
	}
	return "", false
}

func ParseRectJSON(source string) Rect {
	var rect Rect
	_ = json.Unmarshal([]byte(source), &rect)
	return rect
}

func ParseDisplayJSON(source string) Display {
	var display Display
	_ = json.Unmarshal([]byte(source), &display)
	return display
}

func cString(value, label string) (*C.char, func(), error) {
	if strings.ContainsRune(value, '\x00') {
		return nil, nil, fmt.Errorf("%s contains an interior null byte", label)
	}
	ptr := C.CString(value)
	return ptr, func() { C.free(unsafe.Pointer(ptr)) }, nil
}

func cConstString(ptr *C.char) string {
	if ptr == nil {
		return ""
	}
	return C.GoString(ptr)
}

func cbool(value bool) C.bool {
	if value {
		return C.bool(true)
	}
	return C.bool(false)
}

func boolInt(value bool) C.int {
	if value {
		return 1
	}
	return 0
}

func coreLibraryName() string {
	switch runtime.GOOS {
	case "windows":
		return "ElectrobunCore.dll"
	case "darwin":
		return "libElectrobunCore.dylib"
	default:
		return "libElectrobunCore.so"
	}
}

func wgpuLibraryName() string {
	switch runtime.GOOS {
	case "windows":
		return "webgpu_dawn.dll"
	case "darwin":
		return "libwebgpu_dawn.dylib"
	default:
		return "libwebgpu_dawn.so"
	}
}

func tempDir() string {
	if runtime.GOOS == "windows" {
		if value := os.Getenv("TEMP"); value != "" {
			return value
		}
		if value := os.Getenv("TMP"); value != "" {
			return value
		}
		return `C:\Temp`
	}
	if value := os.Getenv("TMPDIR"); value != "" {
		return value
	}
	if value := os.Getenv("TMP"); value != "" {
		return value
	}
	return "/tmp"
}

func appDataDir(home string) string {
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(home, "Library", "Application Support")
	case "windows":
		if value := os.Getenv("APPDATA"); value != "" {
			return value
		}
		return filepath.Join(home, "AppData", "Roaming")
	default:
		if value := os.Getenv("XDG_DATA_HOME"); value != "" {
			return value
		}
		return filepath.Join(home, ".local", "share")
	}
}

func configDir(home string) string {
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(home, "Library", "Application Support")
	case "windows":
		if value := os.Getenv("APPDATA"); value != "" {
			return value
		}
		return filepath.Join(home, "AppData", "Roaming")
	default:
		if value := os.Getenv("XDG_CONFIG_HOME"); value != "" {
			return value
		}
		return filepath.Join(home, ".config")
	}
}

func cacheDir(home string) string {
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(home, "Library", "Caches")
	case "windows":
		if value := os.Getenv("LOCALAPPDATA"); value != "" {
			return value
		}
		return filepath.Join(home, "AppData", "Local")
	default:
		if value := os.Getenv("XDG_CACHE_HOME"); value != "" {
			return value
		}
		return filepath.Join(home, ".cache")
	}
}

func logsDir(home string) string {
	if runtime.GOOS == "darwin" {
		return filepath.Join(home, "Library", "Logs")
	}
	return cacheDir(home)
}
