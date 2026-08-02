use crate::electrobun::{
    self, BundlePaths, Core, Rect, WebviewCallbacks, WebviewOptions, WgpuContext, WgpuNative,
    WindowCallbacks, WindowOptions,
};
use std::ffi::c_void;
use std::os::raw::c_char;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

const DEFAULT_SECRET_KEY: &str =
    "1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32";
const MAX_AGENTS: usize = 5000;
const VERTICES_PER_AGENT: usize = 3;
const FLOATS_PER_VERTEX: usize = 6;
const VERTEX_STRIDE: u64 = (FLOATS_PER_VERTEX * std::mem::size_of::<f32>()) as u64;
const VERTEX_BUFFER_SIZE: u64 =
    (MAX_AGENTS * VERTICES_PER_AGENT * FLOATS_PER_VERTEX * std::mem::size_of::<f32>()) as u64;
const SURFACE_FORMAT: u32 = 0x0000001c;

static APP_STATE: OnceLock<AppState> = OnceLock::new();
static HOST_QUEUE_RUNNING: AtomicBool = AtomicBool::new(false);
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

struct AppState {
    core: &'static Core,
    bundle_paths: BundlePaths,
    flock: Mutex<FlockConfig>,
    webview_id: Mutex<Option<u32>>,
}

#[derive(Clone, Copy)]
struct FlockConfig {
    window_id: u32,
    view_id: u32,
    host_webview_id: u32,
    surface_x: f64,
    surface_y: f64,
    width: u32,
    height: u32,
    agents: usize,
    repel: f32,
    speed: f32,
    cohesion: f32,
    separation: f32,
    running: bool,
}

impl FlockConfig {
    const fn new() -> Self {
        Self {
            window_id: 0,
            view_id: 0,
            host_webview_id: 0,
            surface_x: 0.0,
            surface_y: 0.0,
            width: 800,
            height: 540,
            agents: 2600,
            repel: 6.5,
            speed: 145.0,
            cohesion: 3.25,
            separation: 5.5,
            running: false,
        }
    }
}

#[derive(Clone, Copy, Default)]
struct Agent {
    x: f32,
    y: f32,
    vx: f32,
    vy: f32,
    tone: f32,
}

struct Simulation {
    agents: Vec<Agent>,
    updated: Vec<Agent>,
    grid: Vec<i32>,
    next: Vec<i32>,
    rng: Lcg,
    worker_count: usize,
}

impl Simulation {
    fn new(count: usize, width: u32, height: u32) -> Self {
        let mut sim = Self {
            agents: Vec::with_capacity(MAX_AGENTS),
            updated: Vec::with_capacity(MAX_AGENTS),
            grid: Vec::new(),
            next: Vec::new(),
            rng: Lcg::new(0x9e37_79b9_7f4a_7c15),
            worker_count: thread::available_parallelism()
                .map(|count| count.get())
                .unwrap_or(1)
                .clamp(1, 8),
        };
        sim.set_count(count, width, height);
        sim
    }

    fn set_count(&mut self, count: usize, width: u32, height: u32) {
        let count = count.clamp(1, MAX_AGENTS);
        while self.agents.len() < count {
            let agent = self.random_agent(width, height);
            self.agents.push(agent);
        }
        self.agents.truncate(count);
        self.next.resize(count, -1);
        self.updated.resize(count, Agent::default());
    }

    fn random_agent(&mut self, width: u32, height: u32) -> Agent {
        let angle = self.rng.next_f32() * std::f32::consts::TAU;
        let speed = 80.0 + self.rng.next_f32() * 80.0;
        Agent {
            x: self.rng.next_f32() * width.max(1) as f32,
            y: self.rng.next_f32() * height.max(1) as f32,
            vx: angle.cos() * speed,
            vy: angle.sin() * speed,
            tone: self.rng.next_f32(),
        }
    }

    fn step(&mut self, config: FlockConfig, mouse: Option<(f32, f32)>) {
        self.set_count(config.agents, config.width, config.height);
        let width = config.width.max(1) as f32;
        let height = config.height.max(1) as f32;
        let cell_size = 44.0_f32;
        let grid_w = ((width / cell_size).ceil() as usize).clamp(1, 160);
        let grid_h = ((height / cell_size).ceil() as usize).clamp(1, 120);
        self.grid.clear();
        self.grid.resize(grid_w * grid_h, -1);

        for (i, agent) in self.agents.iter().enumerate() {
            let cx = ((agent.x / cell_size).floor() as isize).clamp(0, grid_w as isize - 1);
            let cy = ((agent.y / cell_size).floor() as isize).clamp(0, grid_h as isize - 1);
            let cell = cy as usize * grid_w + cx as usize;
            self.next[i] = self.grid[cell];
            self.grid[cell] = i as i32;
        }

        let radius = 56.0_f32;
        let radius2 = radius * radius;
        let sep_radius = 22.0_f32;
        let sep_radius2 = sep_radius * sep_radius;
        let dt = 1.0 / 60.0;
        let agent_count = self.agents.len();
        let agents = self.agents.as_slice();
        let grid = self.grid.as_slice();
        let next = self.next.as_slice();
        let thread_count = self.worker_count.min((agent_count / 700).max(1));

        if thread_count <= 1 {
            for (i, slot) in self.updated.iter_mut().enumerate() {
                *slot = Self::update_agent(
                    i,
                    agents,
                    grid,
                    next,
                    grid_w,
                    grid_h,
                    width,
                    height,
                    cell_size,
                    radius2,
                    sep_radius2,
                    dt,
                    config,
                    mouse,
                );
            }
        } else {
            let chunk_size = (agent_count + thread_count - 1) / thread_count;
            thread::scope(|scope| {
                for (chunk_index, chunk) in self.updated.chunks_mut(chunk_size).enumerate() {
                    let start = chunk_index * chunk_size;
                    scope.spawn(move || {
                        for (offset, slot) in chunk.iter_mut().enumerate() {
                            *slot = Self::update_agent(
                                start + offset,
                                agents,
                                grid,
                                next,
                                grid_w,
                                grid_h,
                                width,
                                height,
                                cell_size,
                                radius2,
                                sep_radius2,
                                dt,
                                config,
                                mouse,
                            );
                        }
                    });
                }
            });
        }

        std::mem::swap(&mut self.agents, &mut self.updated);
    }

    fn update_agent(
        i: usize,
        agents: &[Agent],
        grid: &[i32],
        next: &[i32],
        grid_w: usize,
        grid_h: usize,
        width: f32,
        height: f32,
        cell_size: f32,
        radius2: f32,
        sep_radius2: f32,
        dt: f32,
        config: FlockConfig,
        mouse: Option<(f32, f32)>,
    ) -> Agent {
        let a = agents[i];
        let cx = ((a.x / cell_size).floor() as isize).clamp(0, grid_w as isize - 1);
        let cy = ((a.y / cell_size).floor() as isize).clamp(0, grid_h as isize - 1);
        let mut count = 0.0_f32;
        let mut avg_vx = 0.0_f32;
        let mut avg_vy = 0.0_f32;
        let mut center_x = 0.0_f32;
        let mut center_y = 0.0_f32;
        let mut sep_x = 0.0_f32;
        let mut sep_y = 0.0_f32;

        for oy in -1..=1 {
            for ox in -1..=1 {
                let nx = cx + ox;
                let ny = cy + oy;
                if nx < 0 || ny < 0 || nx >= grid_w as isize || ny >= grid_h as isize {
                    continue;
                }
                let mut cursor = grid[ny as usize * grid_w + nx as usize];
                while cursor >= 0 {
                    let j = cursor as usize;
                    if j != i {
                        let b = agents[j];
                        let dx = b.x - a.x;
                        let dy = b.y - a.y;
                        let d2 = dx * dx + dy * dy;
                        if d2 > 0.001 && d2 < radius2 {
                            count += 1.0;
                            avg_vx += b.vx;
                            avg_vy += b.vy;
                            center_x += b.x;
                            center_y += b.y;
                            if d2 < sep_radius2 {
                                let inv = 1.0 / d2.max(4.0);
                                sep_x -= dx * inv;
                                sep_y -= dy * inv;
                            }
                        }
                    }
                    cursor = next[j];
                }
            }
        }

        let mut ax = 0.0_f32;
        let mut ay = 0.0_f32;
        if count > 0.0 {
            let inv_count = 1.0 / count;
            avg_vx *= inv_count;
            avg_vy *= inv_count;
            center_x *= inv_count;
            center_y *= inv_count;
            ax += (avg_vx - a.vx) * 0.55;
            ay += (avg_vy - a.vy) * 0.55;
            ax += (center_x - a.x) * 0.018 * config.cohesion;
            ay += (center_y - a.y) * 0.018 * config.cohesion;
            ax += sep_x * 1650.0 * config.separation;
            ay += sep_y * 1650.0 * config.separation;
        }

        if let Some((mx, my)) = mouse {
            let dx = a.x - mx;
            let dy = a.y - my;
            let d2 = dx * dx + dy * dy;
            let repel_radius = 76.0 + config.repel * 18.0;
            if d2 > 0.001 && d2 < repel_radius * repel_radius {
                let d = d2.sqrt();
                let falloff = (1.0 - d / repel_radius).max(0.0);
                let force = falloff * falloff * (900.0 + config.repel * 260.0);
                ax += dx / d * force;
                ay += dy / d * force;
            }
        }

        let mut vx = a.vx + ax * dt;
        let mut vy = a.vy + ay * dt;
        let speed = (vx * vx + vy * vy).sqrt().max(0.001);
        let target = config.speed;
        let max_speed = target * 1.85;
        let min_speed = target * 0.35;
        let clamped = speed.clamp(min_speed, max_speed);
        vx = vx / speed * clamped;
        vy = vy / speed * clamped;

        let mut x = a.x + vx * dt;
        let mut y = a.y + vy * dt;
        if x < -8.0 {
            x += width + 16.0;
        } else if x > width + 8.0 {
            x -= width + 16.0;
        }
        if y < -8.0 {
            y += height + 16.0;
        } else if y > height + 8.0 {
            y -= height + 16.0;
        }

        Agent {
            x,
            y,
            vx,
            vy,
            tone: a.tone,
        }
    }

    fn write_vertices(&self, config: FlockConfig, mouse: Option<(f32, f32)>, out: &mut Vec<f32>) {
        let width = config.width.max(1) as f32;
        let height = config.height.max(1) as f32;
        let floats_per_agent = VERTICES_PER_AGENT * FLOATS_PER_VERTEX;
        out.resize(self.agents.len() * floats_per_agent, 0.0);
        for (i, agent) in self.agents.iter().enumerate() {
            let speed = (agent.vx * agent.vx + agent.vy * agent.vy)
                .sqrt()
                .max(0.001);
            let dir_x = agent.vx / speed;
            let dir_y = agent.vy / speed;
            let perp_x = -dir_y;
            let perp_y = dir_x;
            let mut influence = 0.0_f32;
            if let Some((mx, my)) = mouse {
                let dx = agent.x - mx;
                let dy = agent.y - my;
                let d = (dx * dx + dy * dy).sqrt();
                influence = (1.0 - d / 170.0).clamp(0.0, 1.0);
            }

            let size = 3.3 + speed / config.speed.max(1.0) * 2.4;
            let nose = (agent.x + dir_x * size * 2.2, agent.y + dir_y * size * 2.2);
            let left = (
                agent.x - dir_x * size + perp_x * size * 0.9,
                agent.y - dir_y * size + perp_y * size * 0.9,
            );
            let right = (
                agent.x - dir_x * size - perp_x * size * 0.9,
                agent.y - dir_y * size - perp_y * size * 0.9,
            );

            let r = 0.20 + influence * 0.78 + agent.tone * 0.08;
            let g = 0.62 + agent.tone * 0.30;
            let b = 0.76 + (1.0 - influence) * 0.18;
            let base = i * floats_per_agent;
            write_vertex(
                &mut out[base..base + FLOATS_PER_VERTEX],
                nose,
                width,
                height,
                [r, g, b, 1.0],
            );
            write_vertex(
                &mut out[base + FLOATS_PER_VERTEX..base + FLOATS_PER_VERTEX * 2],
                left,
                width,
                height,
                [0.08 + r * 0.45, g * 0.82, b, 1.0],
            );
            write_vertex(
                &mut out[base + FLOATS_PER_VERTEX * 2..base + FLOATS_PER_VERTEX * 3],
                right,
                width,
                height,
                [0.08 + r * 0.45, g * 0.82, b, 1.0],
            );
        }
    }
}

fn write_vertex(out: &mut [f32], point: (f32, f32), width: f32, height: f32, color: [f32; 4]) {
    out[0] = point.0 / width * 2.0 - 1.0;
    out[1] = 1.0 - point.1 / height * 2.0;
    out[2] = color[0];
    out[3] = color[1];
    out[4] = color[2];
    out[5] = color[3];
}

struct Lcg {
    state: u64,
}

impl Lcg {
    const fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    fn next_f32(&mut self) -> f32 {
        self.state = self
            .state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((self.state >> 40) as u32) as f32 / (1_u32 << 24) as f32
    }
}

struct WgpuApi {
    device_create_shader_module: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void,
    device_create_render_pipeline: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void,
    device_create_buffer: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void,
    device_create_command_encoder: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void,
    texture_create_view: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void,
    command_encoder_begin_render_pass:
        unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void,
    render_pass_encoder_set_pipeline: unsafe extern "C" fn(*mut c_void, *mut c_void),
    render_pass_encoder_set_vertex_buffer:
        unsafe extern "C" fn(*mut c_void, u32, *mut c_void, u64, u64),
    render_pass_encoder_draw: unsafe extern "C" fn(*mut c_void, u32, u32, u32, u32),
    render_pass_encoder_end: unsafe extern "C" fn(*mut c_void),
    command_encoder_finish: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void,
    queue_write_buffer: unsafe extern "C" fn(*mut c_void, *mut c_void, u64, *const c_void, u64),
    queue_submit: unsafe extern "C" fn(*mut c_void, u64, *const *mut c_void),
    instance_process_events: unsafe extern "C" fn(*mut c_void),
    texture_release: unsafe extern "C" fn(*mut c_void),
    texture_view_release: unsafe extern "C" fn(*mut c_void),
    command_buffer_release: unsafe extern "C" fn(*mut c_void),
    command_encoder_release: unsafe extern "C" fn(*mut c_void),
}

impl WgpuApi {
    fn load(native: &WgpuNative) -> Result<Self, String> {
        Ok(Self {
            device_create_shader_module: native.symbol("wgpuDeviceCreateShaderModule")?,
            device_create_render_pipeline: native.symbol("wgpuDeviceCreateRenderPipeline")?,
            device_create_buffer: native.symbol("wgpuDeviceCreateBuffer")?,
            device_create_command_encoder: native.symbol("wgpuDeviceCreateCommandEncoder")?,
            texture_create_view: native.symbol("wgpuTextureCreateView")?,
            command_encoder_begin_render_pass: native
                .symbol("wgpuCommandEncoderBeginRenderPass")?,
            render_pass_encoder_set_pipeline: native.symbol("wgpuRenderPassEncoderSetPipeline")?,
            render_pass_encoder_set_vertex_buffer: native
                .symbol("wgpuRenderPassEncoderSetVertexBuffer")?,
            render_pass_encoder_draw: native.symbol("wgpuRenderPassEncoderDraw")?,
            render_pass_encoder_end: native.symbol("wgpuRenderPassEncoderEnd")?,
            command_encoder_finish: native.symbol("wgpuCommandEncoderFinish")?,
            queue_write_buffer: native.symbol("wgpuQueueWriteBuffer")?,
            queue_submit: native.symbol("wgpuQueueSubmit")?,
            instance_process_events: native.symbol("wgpuInstanceProcessEvents")?,
            texture_release: native.symbol("wgpuTextureRelease")?,
            texture_view_release: native.symbol("wgpuTextureViewRelease")?,
            command_buffer_release: native.symbol("wgpuCommandBufferRelease")?,
            command_encoder_release: native.symbol("wgpuCommandEncoderRelease")?,
        })
    }
}

struct GpuPipeline {
    pipeline: *mut c_void,
    vertex_buffer: *mut c_void,
}

const FLOCK_SHADER: &str = r#"
struct VSOut {
  @builtin(position) position : vec4<f32>,
  @location(0) color : vec4<f32>,
};

@vertex
fn vs_main(@location(0) position: vec2<f32>, @location(1) color: vec4<f32>) -> VSOut {
  var out: VSOut;
  out.position = vec4<f32>(position, 0.0, 1.0);
  out.color = color;
  return out;
}

@fragment
fn fs_main(@location(0) color: vec4<f32>) -> @location(0) vec4<f32> {
  return color;
}
"#;

pub fn main() {
    if let Err(err) = run() {
        eprintln!("[rust-flock-wgpu] {err}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let core = Box::leak(Box::new(Core::load()?));
    let bundle_paths = electrobun::resolve_bundle_paths()?;
    let app_info = electrobun::resolve_app_info_from_bundle(&bundle_paths)?;

    APP_STATE
        .set(AppState {
            core,
            bundle_paths,
            flock: Mutex::new(FlockConfig::new()),
            webview_id: Mutex::new(None),
        })
        .map_err(|_| "failed to initialize app state".to_string())?;

    let _ui_thread = thread::spawn(create_ui);
    SHUTTING_DOWN.store(false, Ordering::Release);
    HOST_QUEUE_RUNNING.store(true, Ordering::Release);
    let host_queue_thread = thread::spawn(drain_host_message_queue);
    let _render_thread = thread::spawn(flock_render_loop);
    let result = core.run_main_thread(&app_info);
    HOST_QUEUE_RUNNING.store(false, Ordering::Release);
    let _ = host_queue_thread.join();
    result
}

fn app_state() -> &'static AppState {
    APP_STATE
        .get()
        .expect("rust-flock-wgpu state not initialized")
}

fn create_ui() {
    thread::sleep(Duration::from_millis(150));
    let state = app_state();

    if let Err(err) = state
        .core
        .configure_webview_runtime_from_executable_dir(&state.bundle_paths, 0)
    {
        eprintln!("[rust-flock-wgpu] failed to configure webview runtime: {err}");
        return;
    }

    let mut window_options =
        WindowOptions::new("Rust Flock WGPU", Rect::new(140.0, 100.0, 1120.0, 740.0));
    window_options.callbacks = WindowCallbacks {
        close: Some(main_window_closed),
        ..WindowCallbacks::default()
    };

    let window_id = match state.core.create_window(window_options) {
        Ok(id) => id,
        Err(err) => {
            eprintln!("[rust-flock-wgpu] failed to create window: {err}");
            return;
        }
    };

    if let Ok(mut config) = state.flock.lock() {
        config.window_id = window_id;
    }

    let mut webview_options = WebviewOptions::new(
        window_id,
        "views://mainview/index.html",
        Rect::new(0.0, 0.0, 1120.0, 740.0),
    );
    webview_options.secret_key = DEFAULT_SECRET_KEY;
    webview_options.sandbox = false;
    webview_options.callbacks = WebviewCallbacks {
        decide_navigation: Some(electrobun::allow_all_navigation),
        event: Some(electrobun::noop_webview_event),
        event_bridge: Some(electrobun::noop_webview_post_message),
        host_bridge: Some(host_bridge),
        ..WebviewCallbacks::default()
    };

    match state.core.create_webview(webview_options) {
        Ok(webview_id) => {
            if let Ok(mut guard) = state.webview_id.lock() {
                *guard = Some(webview_id);
            }
        }
        Err(err) => {
            eprintln!("[rust-flock-wgpu] failed to create webview: {err}");
            let _ = state.core.close_window(window_id);
        }
    }
}

extern "C" fn main_window_closed(_window_id: u32) {
    request_shutdown();
}

fn request_shutdown() {
    if SHUTTING_DOWN.swap(true, Ordering::AcqRel) {
        return;
    }
    HOST_QUEUE_RUNNING.store(false, Ordering::Release);

    let Some(state) = APP_STATE.get() else {
        return;
    };
    if let Ok(mut config) = state.flock.lock() {
        config.running = false;
        config.view_id = 0;
        config.host_webview_id = 0;
    }
    if let Ok(mut webview_id) = state.webview_id.lock() {
        *webview_id = None;
    }
    let _ = state.core.stop_event_loop();
}

fn drain_host_message_queue() {
    while HOST_QUEUE_RUNNING.load(Ordering::Acquire) {
        let mut drained_any = false;
        while HOST_QUEUE_RUNNING.load(Ordering::Acquire) {
            let Some((webview_id, message)) =
                app_state().core.pop_next_queued_host_message_string()
            else {
                break;
            };
            handle_host_message(webview_id, &message);
            drained_any = true;
        }
        if !drained_any {
            thread::sleep(Duration::from_millis(10));
        }
    }
}

extern "C" fn host_bridge(webview_id: u32, message: *const c_char) {
    let message = electrobun::c_string_to_string(message);
    handle_host_message(webview_id, &message);
}

fn handle_host_message(webview_id: u32, message: &str) {
    if electrobun::json_string_field(message, "type").as_deref() != Some("request") {
        return;
    }
    let Some(request_id) = json_u64_field(message, "id") else {
        return;
    };
    let Some(method) = electrobun::json_string_field(message, "method") else {
        return;
    };
    let params = json_object_field(message, "params").unwrap_or("{}");
    match method.as_str() {
        "startFlock" => {
            if let Err(err) = configure_flock(webview_id, params, true) {
                send_rpc_response_error(webview_id, request_id, &err);
                return;
            }
            send_rpc_response_success(webview_id, request_id, "{\"ok\":true}");
        }
        "configureFlock" => {
            if let Err(err) = configure_flock(webview_id, params, false) {
                send_rpc_response_error(webview_id, request_id, &err);
                return;
            }
            send_rpc_response_success(webview_id, request_id, "{\"ok\":true}");
        }
        _ => send_rpc_response_error(webview_id, request_id, "Unknown RPC request"),
    }
}

fn configure_flock(webview_id: u32, params: &str, start: bool) -> Result<(), String> {
    let rect = json_object_field(params, "rect").ok_or_else(|| "missing rect".to_string())?;
    let config = json_object_field(params, "config").ok_or_else(|| "missing config".to_string())?;
    let view_id = json_u64_field(params, "id").unwrap_or_default() as u32;
    if view_id == 0 {
        return Err("missing WGPU view id".to_string());
    }

    let mut flock = app_state()
        .flock
        .lock()
        .map_err(|_| "failed to lock flock config".to_string())?;
    flock.view_id = view_id;
    flock.host_webview_id = webview_id;
    flock.surface_x = electrobun::json_number_field(rect, "x").unwrap_or(0.0);
    flock.surface_y = electrobun::json_number_field(rect, "y").unwrap_or(0.0);
    flock.width = electrobun::json_number_field(rect, "width")
        .unwrap_or(800.0)
        .round()
        .max(1.0) as u32;
    flock.height = electrobun::json_number_field(rect, "height")
        .unwrap_or(540.0)
        .round()
        .max(1.0) as u32;
    flock.agents = json_u64_field(config, "agents")
        .unwrap_or(flock.agents as u64)
        .clamp(1, MAX_AGENTS as u64) as usize;
    flock.repel =
        electrobun::json_number_field(config, "repel").unwrap_or(flock.repel as f64) as f32;
    flock.speed =
        electrobun::json_number_field(config, "speed").unwrap_or(flock.speed as f64) as f32;
    flock.cohesion =
        electrobun::json_number_field(config, "cohesion").unwrap_or(flock.cohesion as f64) as f32;
    flock.separation = electrobun::json_number_field(config, "separation")
        .unwrap_or(flock.separation as f64) as f32;
    if start {
        flock.running = true;
    }
    Ok(())
}

fn flock_render_loop() {
    let state = app_state();
    let native = match WgpuNative::load() {
        Ok(native) => native,
        Err(err) => {
            eprintln!("[rust-flock-wgpu] failed to load WGPU library: {err}");
            return;
        }
    };
    let api = match WgpuApi::load(&native) {
        Ok(api) => api,
        Err(err) => {
            eprintln!("[rust-flock-wgpu] failed to load WGPU symbols: {err}");
            return;
        }
    };

    let mut simulation = Simulation::new(2600, 800, 540);
    let mut vertices = Vec::with_capacity(MAX_AGENTS * VERTICES_PER_AGENT * FLOATS_PER_VERTEX);
    let mut active_view_id = 0_u32;
    let mut context: Option<WgpuContext> = None;
    let mut pipeline: Option<GpuPipeline> = None;
    let mut queue: *mut c_void = std::ptr::null_mut();
    let mut configured_width = 0_u32;
    let mut configured_height = 0_u32;
    let mut frame = 0_u64;
    let mut last_stat = Instant::now();
    let mut stat_frames = 0_u32;
    let mut last_fps = 0.0_f64;

    while HOST_QUEUE_RUNNING.load(Ordering::Acquire) {
        let config = state
            .flock
            .lock()
            .map(|guard| *guard)
            .unwrap_or_else(|_| FlockConfig::new());

        if !config.running || config.view_id == 0 {
            thread::sleep(Duration::from_millis(16));
            continue;
        }

        if context.is_none() || active_view_id != config.view_id {
            match WgpuContext::create_for_wgpu_view(state.core, &native, config.view_id) {
                Ok(new_context) => {
                    queue = match new_context.get_queue(&native) {
                        Ok(queue) => queue,
                        Err(err) => {
                            eprintln!("[rust-flock-wgpu] failed to get WGPU queue: {err}");
                            thread::sleep(Duration::from_millis(250));
                            continue;
                        }
                    };
                    pipeline = match create_flock_pipeline(&api, new_context) {
                        Ok(pipeline) => Some(pipeline),
                        Err(err) => {
                            eprintln!("[rust-flock-wgpu] failed to create WGPU pipeline: {err}");
                            thread::sleep(Duration::from_millis(250));
                            continue;
                        }
                    };
                    context = Some(new_context);
                    active_view_id = config.view_id;
                    configured_width = 0;
                    configured_height = 0;
                    eprintln!(
                        "[rust-flock-wgpu] WGPU context ready for view {}",
                        config.view_id
                    );
                }
                Err(err) => {
                    eprintln!("[rust-flock-wgpu] failed to create WGPU context: {err}");
                    thread::sleep(Duration::from_millis(250));
                    continue;
                }
            }
        }

        if configured_width != config.width || configured_height != config.height {
            if let Some(context) = context {
                if let Err(err) =
                    configure_surface(state.core, context, config.width, config.height)
                {
                    eprintln!("[rust-flock-wgpu] failed to configure surface: {err}");
                    thread::sleep(Duration::from_millis(250));
                    continue;
                }
                configured_width = config.width;
                configured_height = config.height;
            }
        }

        let mouse = native_cursor_in_surface(state.core, config);
        simulation.step(config, mouse);
        simulation.write_vertices(config, mouse, &mut vertices);

        if let (Some(context), Some(pipeline)) = (context, &pipeline) {
            match render_frame(
                state.core,
                &api,
                context,
                pipeline,
                queue,
                &vertices,
                config.width,
                config.height,
            ) {
                Ok(()) => {}
                Err(err) => {
                    eprintln!("[rust-flock-wgpu] failed to render frame: {err}");
                    thread::sleep(Duration::from_millis(100));
                    continue;
                }
            }
        }

        frame += 1;
        stat_frames += 1;
        let elapsed = last_stat.elapsed();
        if elapsed >= Duration::from_millis(500) {
            last_fps = stat_frames as f64 / elapsed.as_secs_f64();
            stat_frames = 0;
            last_stat = Instant::now();
        }
        if frame % 20 == 0 {
            send_flock_frame(config, frame, last_fps, mouse);
        }

        thread::sleep(Duration::from_millis(16));
    }
}

fn native_cursor_in_surface(core: &Core, config: FlockConfig) -> Option<(f32, f32)> {
    if config.window_id == 0 {
        return None;
    }
    let cursor = core.get_cursor_screen_point().ok()?;
    let frame = core.get_window_frame(config.window_id).ok()?;
    let x = cursor.x - frame.x - config.surface_x;
    let y = cursor.y - frame.y - config.surface_y;
    let margin = 240.0;
    if x < -margin
        || y < -margin
        || x > config.width as f64 + margin
        || y > config.height as f64 + margin
    {
        None
    } else {
        Some((x as f32, y as f32))
    }
}

fn configure_surface(
    core: &Core,
    context: WgpuContext,
    width: u32,
    height: u32,
) -> Result<(), String> {
    const WGPU_TEXTURE_USAGE_RENDER_ATTACHMENT: u64 = 0x0000000000000010;
    const WGPU_COMPOSITE_ALPHA_MODE_OPAQUE: u32 = 0x00000001;
    const WGPU_PRESENT_MODE_FIFO: u32 = 0x00000001;

    let mut config = [0_u8; 64];
    write_ptr(&mut config, 0, std::ptr::null_mut());
    write_ptr(&mut config, 8, context.device_ptr);
    write_u32(&mut config, 16, SURFACE_FORMAT);
    write_u32(&mut config, 20, 0);
    write_u64(&mut config, 24, WGPU_TEXTURE_USAGE_RENDER_ATTACHMENT);
    write_u32(&mut config, 32, width);
    write_u32(&mut config, 36, height);
    write_u64(&mut config, 40, 0);
    write_ptr(&mut config, 48, std::ptr::null_mut());
    write_u32(&mut config, 56, WGPU_COMPOSITE_ALPHA_MODE_OPAQUE);
    write_u32(&mut config, 60, WGPU_PRESENT_MODE_FIFO);
    core.wgpu_surface_configure_main_thread(context.surface_ptr, ptr_from_bytes(&mut config))
}

fn create_flock_pipeline(api: &WgpuApi, context: WgpuContext) -> Result<GpuPipeline, String> {
    const WGPU_VERTEX_FORMAT_FLOAT32X2: u32 = 0x0000001d;
    const WGPU_VERTEX_FORMAT_FLOAT32X4: u32 = 0x0000001f;
    let shader_code = std::ffi::CString::new(FLOCK_SHADER).map_err(|err| err.to_string())?;
    let vs_entry = std::ffi::CString::new("vs_main").map_err(|err| err.to_string())?;
    let fs_entry = std::ffi::CString::new("fs_main").map_err(|err| err.to_string())?;

    let mut shader_source = make_shader_source_wgsl(shader_code.as_ptr() as *const c_void);
    let mut shader_descriptor = make_shader_module_descriptor(ptr_from_bytes(&mut shader_source));
    let shader_module = unsafe {
        (api.device_create_shader_module)(
            context.device_ptr,
            ptr_from_bytes(&mut shader_descriptor),
        )
    };
    if shader_module.is_null() {
        return Err("missing shader module".to_string());
    }

    let mut attributes = [0_u8; 64];
    write_vertex_attribute(&mut attributes, 0, 0, 0, WGPU_VERTEX_FORMAT_FLOAT32X2);
    write_vertex_attribute(&mut attributes, 1, 8, 1, WGPU_VERTEX_FORMAT_FLOAT32X4);

    let mut vertex_layout = make_vertex_buffer_layout(ptr_from_bytes(&mut attributes), 2);
    let vertex_state = make_vertex_state(
        shader_module,
        vs_entry.as_ptr() as *const c_void,
        ptr_from_bytes(&mut vertex_layout),
    );
    let mut color_target = make_color_target_state(SURFACE_FORMAT);
    let mut fragment_state = make_fragment_state(
        shader_module,
        fs_entry.as_ptr() as *const c_void,
        ptr_from_bytes(&mut color_target),
    );
    let primitive_state = make_primitive_state();
    let multisample_state = make_multisample_state();
    let mut pipeline_descriptor = make_render_pipeline_descriptor(
        &vertex_state,
        &primitive_state,
        &multisample_state,
        ptr_from_bytes(&mut fragment_state),
    );

    let pipeline = unsafe {
        (api.device_create_render_pipeline)(
            context.device_ptr,
            ptr_from_bytes(&mut pipeline_descriptor),
        )
    };
    if pipeline.is_null() {
        return Err("missing render pipeline".to_string());
    }

    let mut vertex_buffer_descriptor = make_buffer_descriptor(VERTEX_BUFFER_SIZE);
    let vertex_buffer = unsafe {
        (api.device_create_buffer)(
            context.device_ptr,
            ptr_from_bytes(&mut vertex_buffer_descriptor),
        )
    };
    if vertex_buffer.is_null() {
        return Err("missing vertex buffer".to_string());
    }

    Ok(GpuPipeline {
        pipeline,
        vertex_buffer,
    })
}

fn render_frame(
    core: &Core,
    api: &WgpuApi,
    context: WgpuContext,
    pipeline: &GpuPipeline,
    queue: *mut c_void,
    vertices: &[f32],
    _width: u32,
    _height: u32,
) -> Result<(), String> {
    const WGPU_DEPTH_SLICE_UNDEFINED: u32 = 0xffffffff;
    const WGPU_LOAD_OP_CLEAR: u32 = 0x00000002;
    const WGPU_STORE_OP_STORE: u32 = 0x00000001;

    unsafe {
        (api.instance_process_events)(context.instance_ptr);
    }

    let active_bytes = std::mem::size_of_val(vertices) as u64;
    if active_bytes > 0 {
        unsafe {
            (api.queue_write_buffer)(
                queue,
                pipeline.vertex_buffer,
                0,
                vertices.as_ptr() as *const c_void,
                active_bytes,
            );
        }
    }

    let mut surface_texture = [0_u8; 24];
    core.wgpu_surface_get_current_texture_main_thread(
        context.surface_ptr,
        ptr_from_bytes(&mut surface_texture),
    )?;
    let texture_ptr = read_u64(&surface_texture, 8) as *mut c_void;
    let status = read_u32(&surface_texture, 16);
    if status != 1 && status != 2 {
        return Err("surface texture unavailable".to_string());
    }
    if texture_ptr.is_null() {
        return Err("missing surface texture".to_string());
    }

    let texture_view = unsafe { (api.texture_create_view)(texture_ptr, std::ptr::null_mut()) };
    if texture_view.is_null() {
        unsafe {
            (api.texture_release)(texture_ptr);
        }
        return Err("missing texture view".to_string());
    }

    let encoder =
        unsafe { (api.device_create_command_encoder)(context.device_ptr, std::ptr::null_mut()) };
    if encoder.is_null() {
        unsafe {
            (api.texture_view_release)(texture_view);
            (api.texture_release)(texture_ptr);
        }
        return Err("missing command encoder".to_string());
    }

    let mut color_attachment = [0_u8; 72];
    write_ptr(&mut color_attachment, 8, texture_view);
    write_u32(&mut color_attachment, 16, WGPU_DEPTH_SLICE_UNDEFINED);
    write_ptr(&mut color_attachment, 24, std::ptr::null_mut());
    write_u32(&mut color_attachment, 32, WGPU_LOAD_OP_CLEAR);
    write_u32(&mut color_attachment, 36, WGPU_STORE_OP_STORE);
    write_f64(&mut color_attachment, 40, 0.008);
    write_f64(&mut color_attachment, 48, 0.010);
    write_f64(&mut color_attachment, 56, 0.014);
    write_f64(&mut color_attachment, 64, 1.0);

    let mut pass_descriptor = [0_u8; 64];
    write_u64(&mut pass_descriptor, 24, 1);
    write_ptr(
        &mut pass_descriptor,
        32,
        ptr_from_bytes(&mut color_attachment),
    );

    let pass = unsafe {
        (api.command_encoder_begin_render_pass)(encoder, ptr_from_bytes(&mut pass_descriptor))
    };
    if pass.is_null() {
        unsafe {
            (api.command_encoder_release)(encoder);
            (api.texture_view_release)(texture_view);
            (api.texture_release)(texture_ptr);
        }
        return Err("missing render pass".to_string());
    }

    let vertex_count = (vertices.len() / FLOATS_PER_VERTEX) as u32;
    unsafe {
        (api.render_pass_encoder_set_pipeline)(pass, pipeline.pipeline);
        (api.render_pass_encoder_set_vertex_buffer)(
            pass,
            0,
            pipeline.vertex_buffer,
            0,
            active_bytes,
        );
        (api.render_pass_encoder_draw)(pass, vertex_count, 1, 0, 0);
        (api.render_pass_encoder_end)(pass);
    }

    let command_buffer = unsafe { (api.command_encoder_finish)(encoder, std::ptr::null_mut()) };
    if command_buffer.is_null() {
        unsafe {
            (api.command_encoder_release)(encoder);
            (api.texture_view_release)(texture_view);
            (api.texture_release)(texture_ptr);
        }
        return Err("missing command buffer".to_string());
    }

    let commands = [command_buffer];
    unsafe {
        (api.queue_submit)(queue, 1, commands.as_ptr());
    }
    let _ = core.wgpu_surface_present_main_thread(context.surface_ptr)?;

    unsafe {
        (api.command_buffer_release)(command_buffer);
        (api.command_encoder_release)(encoder);
        (api.texture_view_release)(texture_view);
        (api.texture_release)(texture_ptr);
    }
    Ok(())
}

fn send_flock_frame(config: FlockConfig, frame: u64, fps: f64, mouse: Option<(f32, f32)>) {
    if !HOST_QUEUE_RUNNING.load(Ordering::Acquire) || config.host_webview_id == 0 {
        return;
    }
    let (cursor_x, cursor_y) = mouse.unwrap_or((-1.0, -1.0));
    let payload = format!(
        "{{\"frame\":{},\"agents\":{},\"fps\":{},\"cursorX\":{},\"cursorY\":{},\"width\":{},\"height\":{}}}",
        frame, config.agents, fps, cursor_x, cursor_y, config.width, config.height
    );
    send_rpc_message(config.host_webview_id, "flockFrame", &payload);
}

fn send_rpc_message(webview_id: u32, message_id: &str, payload_json: &str) {
    let packet = format!(
        "{{\"type\":\"message\",\"id\":{},\"payload\":{}}}",
        electrobun::json_string_literal(message_id),
        payload_json
    );
    if let Err(err) = app_state()
        .core
        .send_host_message_to_webview_json(webview_id, &packet)
    {
        handle_webview_send_error("send RPC message", err);
    }
}

fn send_rpc_response_success(webview_id: u32, request_id: u64, payload_json: &str) {
    let packet = format!(
        "{{\"type\":\"response\",\"id\":{},\"success\":true,\"payload\":{}}}",
        request_id, payload_json
    );
    if let Err(err) = app_state()
        .core
        .send_host_message_to_webview_json(webview_id, &packet)
    {
        handle_webview_send_error("send RPC response", err);
    }
}

fn send_rpc_response_error(webview_id: u32, request_id: u64, error_message: &str) {
    let packet = format!(
        "{{\"type\":\"response\",\"id\":{},\"success\":false,\"error\":{}}}",
        request_id,
        electrobun::json_string_literal(error_message)
    );
    if let Err(err) = app_state()
        .core
        .send_host_message_to_webview_json(webview_id, &packet)
    {
        handle_webview_send_error("send RPC error", err);
    }
}

fn handle_webview_send_error(action: &str, err: String) {
    if err.contains("not found") {
        request_shutdown();
        return;
    }
    if !SHUTTING_DOWN.load(Ordering::Acquire) {
        eprintln!("[rust-flock-wgpu] failed to {action}: {err}");
    }
}

fn make_shader_source_wgsl(code_ptr: *const c_void) -> [u8; 32] {
    const WGPU_STYPE_SHADER_SOURCE_WGSL: u32 = 0x00000002;
    const WGPU_STRLEN: u64 = u64::MAX;

    let mut bytes = [0_u8; 32];
    write_ptr(&mut bytes, 0, std::ptr::null_mut());
    write_u32(&mut bytes, 8, WGPU_STYPE_SHADER_SOURCE_WGSL);
    write_const_ptr(&mut bytes, 16, code_ptr);
    write_u64(&mut bytes, 24, WGPU_STRLEN);
    bytes
}

fn make_shader_module_descriptor(source_ptr: *mut c_void) -> [u8; 24] {
    let mut bytes = [0_u8; 24];
    write_ptr(&mut bytes, 0, source_ptr);
    write_ptr(&mut bytes, 8, std::ptr::null_mut());
    write_u64(&mut bytes, 16, 0);
    bytes
}

fn write_vertex_attribute(bytes: &mut [u8], index: usize, offset: u64, location: u32, format: u32) {
    let base = index * 32;
    write_ptr(bytes, base, std::ptr::null_mut());
    write_u32(bytes, base + 8, format);
    write_u64(bytes, base + 16, offset);
    write_u32(bytes, base + 24, location);
}

fn make_vertex_buffer_layout(attributes_ptr: *mut c_void, attribute_count: u64) -> [u8; 40] {
    const WGPU_VERTEX_STEP_MODE_VERTEX: u32 = 0x00000001;

    let mut bytes = [0_u8; 40];
    write_ptr(&mut bytes, 0, std::ptr::null_mut());
    write_u32(&mut bytes, 8, WGPU_VERTEX_STEP_MODE_VERTEX);
    write_u64(&mut bytes, 16, VERTEX_STRIDE);
    write_u64(&mut bytes, 24, attribute_count);
    write_ptr(&mut bytes, 32, attributes_ptr);
    bytes
}

fn make_color_target_state(format: u32) -> [u8; 32] {
    const WGPU_COLOR_WRITE_MASK_ALL: u64 = 0x000000000000000f;

    let mut bytes = [0_u8; 32];
    write_ptr(&mut bytes, 0, std::ptr::null_mut());
    write_u32(&mut bytes, 8, format);
    write_ptr(&mut bytes, 16, std::ptr::null_mut());
    write_u64(&mut bytes, 24, WGPU_COLOR_WRITE_MASK_ALL);
    bytes
}

fn make_vertex_state(
    module: *mut c_void,
    entry: *const c_void,
    vertex_layout_ptr: *mut c_void,
) -> [u8; 64] {
    const WGPU_STRLEN: u64 = u64::MAX;

    let mut bytes = [0_u8; 64];
    write_ptr(&mut bytes, 0, std::ptr::null_mut());
    write_ptr(&mut bytes, 8, module);
    write_const_ptr(&mut bytes, 16, entry);
    write_u64(&mut bytes, 24, WGPU_STRLEN);
    write_u64(&mut bytes, 32, 0);
    write_ptr(&mut bytes, 40, std::ptr::null_mut());
    write_u64(&mut bytes, 48, 1);
    write_ptr(&mut bytes, 56, vertex_layout_ptr);
    bytes
}

fn make_fragment_state(
    module: *mut c_void,
    entry: *const c_void,
    color_target_ptr: *mut c_void,
) -> [u8; 64] {
    const WGPU_STRLEN: u64 = u64::MAX;

    let mut bytes = [0_u8; 64];
    write_ptr(&mut bytes, 0, std::ptr::null_mut());
    write_ptr(&mut bytes, 8, module);
    write_const_ptr(&mut bytes, 16, entry);
    write_u64(&mut bytes, 24, WGPU_STRLEN);
    write_u64(&mut bytes, 32, 0);
    write_ptr(&mut bytes, 40, std::ptr::null_mut());
    write_u64(&mut bytes, 48, 1);
    write_ptr(&mut bytes, 56, color_target_ptr);
    bytes
}

fn make_primitive_state() -> [u8; 32] {
    const WGPU_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST: u32 = 0x00000004;
    const WGPU_FRONT_FACE_CCW: u32 = 0x00000001;
    const WGPU_CULL_MODE_NONE: u32 = 0x00000001;

    let mut bytes = [0_u8; 32];
    write_ptr(&mut bytes, 0, std::ptr::null_mut());
    write_u32(&mut bytes, 8, WGPU_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST);
    write_u32(&mut bytes, 16, WGPU_FRONT_FACE_CCW);
    write_u32(&mut bytes, 20, WGPU_CULL_MODE_NONE);
    bytes
}

fn make_multisample_state() -> [u8; 24] {
    let mut bytes = [0_u8; 24];
    write_ptr(&mut bytes, 0, std::ptr::null_mut());
    write_u32(&mut bytes, 8, 1);
    write_u32(&mut bytes, 12, 0xffffffff);
    bytes
}

fn make_render_pipeline_descriptor(
    vertex_state: &[u8; 64],
    primitive_state: &[u8; 32],
    multisample_state: &[u8; 24],
    fragment_state_ptr: *mut c_void,
) -> [u8; 168] {
    let mut bytes = [0_u8; 168];
    write_ptr(&mut bytes, 0, std::ptr::null_mut());
    write_ptr(&mut bytes, 8, std::ptr::null_mut());
    write_u64(&mut bytes, 16, 0);
    write_ptr(&mut bytes, 24, std::ptr::null_mut());
    bytes[32..96].copy_from_slice(vertex_state);
    bytes[96..128].copy_from_slice(primitive_state);
    write_ptr(&mut bytes, 128, std::ptr::null_mut());
    bytes[136..160].copy_from_slice(multisample_state);
    write_ptr(&mut bytes, 160, fragment_state_ptr);
    bytes
}

fn make_buffer_descriptor(size: u64) -> [u8; 48] {
    const WGPU_BUFFER_USAGE_VERTEX: u64 = 0x0000000000000020;
    const WGPU_BUFFER_USAGE_COPY_DST: u64 = 0x0000000000000008;

    let mut bytes = [0_u8; 48];
    write_ptr(&mut bytes, 0, std::ptr::null_mut());
    write_ptr(&mut bytes, 8, std::ptr::null_mut());
    write_u64(&mut bytes, 16, 0);
    write_u64(
        &mut bytes,
        24,
        WGPU_BUFFER_USAGE_VERTEX | WGPU_BUFFER_USAGE_COPY_DST,
    );
    write_u64(&mut bytes, 32, size);
    bytes
}

fn write_ptr(bytes: &mut [u8], offset: usize, ptr: *mut c_void) {
    write_u64(bytes, offset, ptr as usize as u64);
}

fn write_const_ptr(bytes: &mut [u8], offset: usize, ptr: *const c_void) {
    write_u64(bytes, offset, ptr as usize as u64);
}

fn write_u32(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn write_u64(bytes: &mut [u8], offset: usize, value: u64) {
    bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}

fn write_f64(bytes: &mut [u8], offset: usize, value: f64) {
    bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}

fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap_or([0; 4]))
}

fn read_u64(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap_or([0; 8]))
}

fn ptr_from_bytes(bytes: &mut [u8]) -> *mut c_void {
    bytes.as_mut_ptr() as *mut c_void
}

fn json_u64_field(source: &str, key: &str) -> Option<u64> {
    let needle = format!("\"{key}\"");
    let key_index = source.find(&needle)?;
    let after_key = &source[key_index + needle.len()..];
    let colon_index = after_key.find(':')?;
    let after_colon = after_key[colon_index + 1..].trim_start();
    let digits: String = after_colon
        .chars()
        .take_while(|ch| ch.is_ascii_digit())
        .collect();
    digits.parse().ok()
}

fn json_object_field<'a>(source: &'a str, key: &str) -> Option<&'a str> {
    let value = json_value_field(source, key)?;
    if value.trim_start().starts_with('{') {
        Some(value)
    } else {
        None
    }
}

fn json_value_field<'a>(source: &'a str, key: &str) -> Option<&'a str> {
    let needle = format!("\"{key}\"");
    let key_index = source.find(&needle)?;
    let after_key = &source[key_index + needle.len()..];
    let colon_index = after_key.find(':')?;
    let mut start = key_index + needle.len() + colon_index + 1;
    while let Some(ch) = source[start..].chars().next() {
        if !ch.is_whitespace() {
            break;
        }
        start += ch.len_utf8();
    }

    let first = *source.as_bytes().get(start)?;
    if first == b'{' || first == b'[' {
        let open = first as char;
        let close = if open == '{' { '}' } else { ']' };
        let mut depth = 0_i32;
        let mut in_string = false;
        let mut escaped = false;
        for (offset, ch) in source[start..].char_indices() {
            if in_string {
                if escaped {
                    escaped = false;
                } else if ch == '\\' {
                    escaped = true;
                } else if ch == '"' {
                    in_string = false;
                }
                continue;
            }
            if ch == '"' {
                in_string = true;
            } else if ch == open {
                depth += 1;
            } else if ch == close {
                depth -= 1;
                if depth == 0 {
                    let end = start + offset + ch.len_utf8();
                    return Some(&source[start..end]);
                }
            }
        }
        return None;
    }

    let mut end = source.len();
    for (offset, ch) in source[start..].char_indices() {
        if ch == ',' || ch == '}' || ch == ']' {
            end = start + offset;
            break;
        }
    }
    Some(source[start..end].trim())
}
