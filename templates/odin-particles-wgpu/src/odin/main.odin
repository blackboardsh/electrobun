// Odin WGPU particles: a data-oriented particle simulation in the Odin main
// process, rendered as additive-blended instanced quads on a native
// <electrobun-wgpu> surface.
//
// The signature Odin feature on display is `#soa`: particle state lives in a
// structure-of-arrays laid out by the language itself (see `Sim.particles`),
// and the update loop is written as tight per-field passes over those arrays,
// the way game/VFX tooling written in Odin does it.
//
// Wiring mirrors templates/zig-wgpu/src/zig/main.zig: the webview owns layout
// and controls, the Odin process owns the simulation and the WGPU pipeline,
// and the two sides talk over Electrobun's host-message RPC transport.
package main

import "base:intrinsics"
import "base:runtime"
import "core:dynlib"
import "core:encoding/json"
import "core:fmt"
import "core:math"
import "core:sync"
import "core:thread"
import "core:time"

import electrobun "electrobun_sdk:electrobun"

DEFAULT_SECRET_KEY :: "1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32"

// ---------------------------------------------------------------------------
// Simulation data: #soa particle storage
// ---------------------------------------------------------------------------

MAX_PARTICLES :: 50_000
DEFAULT_TARGET :: 20_000

// One particle. Declared as a plain struct, stored as a structure of arrays:
// `#soa[MAX_PARTICLES]Particle` makes the compiler lay out one contiguous
// array per field (all x's together, all vx's together, ...), so the update
// passes below stream linearly through memory.
Particle :: struct {
	x, y:     f32, // position, world units (y in [-1, 1], x in [-aspect, aspect])
	vx, vy:   f32, // velocity, world units / second
	life:     f32, // seconds remaining
	lifespan: f32, // seconds at spawn (for fade-out)
	size:     f32, // half-extent of the quad, world units
	hue:      f32, // palette coordinate
}

Emitter_Mode :: enum u32 {
	Fountain  = 0,
	Fireworks = 1,
	Vortex    = 2,
}

Sim_Params :: struct {
	mode:    Emitter_Mode,
	target:  int, // desired live particle count
	gravity: f32, // normalized 0..1
	force:   f32, // normalized 0..1 (launch speed / swirl strength)
	paused:  bool,
}

default_sim_params :: proc() -> Sim_Params {
	return {mode = .Fountain, target = DEFAULT_TARGET, gravity = 0.5, force = 0.5}
}

Sim :: struct {
	particles:   #soa[MAX_PARTICLES]Particle,
	alive:       int,
	rng:         u32,
	emit_carry:  f32,
	burst_timer: f32,
	clock:       f32,
}

RNG_SEED :: 0x9E3779B9

sim_reset :: proc(sim: ^Sim) {
	sim.alive = 0
	sim.rng = RNG_SEED
	sim.emit_carry = 0
	sim.burst_timer = 0
	sim.clock = 0
}

// Tiny deterministic xorshift32 so the sim is reproducible run to run.
rand_u32 :: proc(state: ^u32) -> u32 {
	x := state^
	x ~= x << 13
	x ~= x >> 17
	x ~= x << 5
	state^ = x
	return x
}

rand_f32 :: proc(state: ^u32) -> f32 {
	return f32(rand_u32(state) >> 8) / f32(1 << 24)
}

rand_range :: proc(state: ^u32, lo, hi: f32) -> f32 {
	return lo + (hi - lo) * rand_f32(state)
}

spawn :: proc(sim: ^Sim, p: Particle) {
	if sim.alive >= MAX_PARTICLES {
		return
	}
	sim.particles[sim.alive] = p
	sim.alive += 1
}

// ---------------------------------------------------------------------------
// Emitters
// ---------------------------------------------------------------------------

emit_fountain :: proc(sim: ^Sim, params: Sim_Params, dt: f32) {
	AVG_LIFESPAN :: f32(2.2)
	rate := f32(params.target) / AVG_LIFESPAN
	sim.emit_carry += rate * dt
	count := int(sim.emit_carry)
	sim.emit_carry -= f32(count)

	speed_base := 1.15 + params.force * 1.55
	for _ in 0 ..< count {
		if sim.alive >= params.target {
			break
		}
		angle := (rand_f32(&sim.rng) - 0.5) * 0.55
		speed := speed_base * rand_range(&sim.rng, 0.55, 1.0)
		lifespan := rand_range(&sim.rng, 1.6, 2.8)
		spawn(
			sim,
			Particle{
				x = (rand_f32(&sim.rng) - 0.5) * 0.04,
				y = -0.92,
				vx = math.sin(angle) * speed,
				vy = math.cos(angle) * speed,
				life = lifespan,
				lifespan = lifespan,
				size = rand_range(&sim.rng, 0.006, 0.016),
				hue = 0.52 + rand_f32(&sim.rng) * 0.14 + math.sin(sim.clock * 0.21) * 0.05,
			},
		)
	}
}

emit_fireworks :: proc(sim: ^Sim, params: Sim_Params, dt: f32, aspect: f32) {
	sim.burst_timer -= dt
	if sim.burst_timer > 0 {
		return
	}
	sim.burst_timer = rand_range(&sim.rng, 0.3, 0.65)

	burst := clamp(params.target / 8, 150, 4000)
	if sim.alive + burst > params.target {
		burst = max(params.target - sim.alive, 0)
	}
	if burst == 0 {
		return
	}

	origin_x := (rand_f32(&sim.rng) - 0.5) * 1.3 * aspect
	origin_y := rand_range(&sim.rng, 0.0, 0.65)
	shell_speed := 0.55 + params.force * 1.35
	hue := rand_f32(&sim.rng)

	for _ in 0 ..< burst {
		angle := rand_f32(&sim.rng) * math.TAU
		speed := shell_speed * (0.35 + 0.65 * math.sqrt(rand_f32(&sim.rng)))
		lifespan := rand_range(&sim.rng, 1.1, 2.1)
		spawn(
			sim,
			Particle{
				x = origin_x,
				y = origin_y,
				vx = math.cos(angle) * speed,
				vy = math.sin(angle) * speed,
				life = lifespan,
				lifespan = lifespan,
				size = rand_range(&sim.rng, 0.005, 0.012),
				hue = hue + rand_f32(&sim.rng) * 0.08,
			},
		)
	}
}

emit_vortex :: proc(sim: ^Sim, params: Sim_Params, dt: f32, aspect: f32) {
	AVG_LIFESPAN :: f32(2.8)
	rate := f32(params.target) / AVG_LIFESPAN
	sim.emit_carry += rate * dt
	count := int(sim.emit_carry)
	sim.emit_carry -= f32(count)

	ring := 0.72 * min(aspect, 1.0)
	for _ in 0 ..< count {
		if sim.alive >= params.target {
			break
		}
		angle := rand_f32(&sim.rng) * math.TAU
		radius := ring * rand_range(&sim.rng, 0.85, 1.1)
		tangent := 0.35 + params.force * 0.6
		lifespan := rand_range(&sim.rng, 2.0, 3.6)
		spawn(
			sim,
			Particle{
				x = math.cos(angle) * radius,
				y = math.sin(angle) * radius,
				vx = -math.sin(angle) * tangent,
				vy = math.cos(angle) * tangent,
				life = lifespan,
				lifespan = lifespan,
				size = rand_range(&sim.rng, 0.005, 0.013),
				hue = 0.62 + 0.25 * rand_f32(&sim.rng) + angle * 0.015,
			},
		)
	}
}

// ---------------------------------------------------------------------------
// Update: data-oriented passes over the #soa arrays
// ---------------------------------------------------------------------------

sim_update :: proc(sim: ^Sim, params: Sim_Params, dt: f32, aspect: f32) {
	sim.clock += dt

	switch params.mode {
	case .Fountain:
		emit_fountain(sim, params, dt)
	case .Fireworks:
		emit_fireworks(sim, params, dt, aspect)
	case .Vortex:
		emit_vortex(sim, params, dt, aspect)
	}

	// `ps` is an #soa slice: ps.vx, ps.vy, ... are each one contiguous array.
	// Every pass below touches only the fields it needs, in order.
	ps := sim.particles[:sim.alive]

	// Pass 1: forces (per emitter mode).
	switch params.mode {
	case .Fountain:
		g := 0.35 + params.gravity * 2.3
		turbulence := 0.12 + params.force * 0.5
		t := sim.clock
		for i in 0 ..< len(ps) {
			ps.vy[i] -= g * dt
			ps.vx[i] += math.sin(ps.y[i] * 3.1 + t * 1.9) * turbulence * dt
		}
	case .Fireworks:
		g := 0.15 + params.gravity * 1.2
		for i in 0 ..< len(ps) {
			ps.vy[i] -= g * dt
		}
	case .Vortex:
		swirl := 0.9 + params.force * 2.7
		pull := 0.22 + params.gravity * 0.85
		for i in 0 ..< len(ps) {
			x := ps.x[i]
			y := ps.y[i]
			r := max(math.sqrt(x * x + y * y), 0.06)
			inv_r := 1.0 / r
			falloff := 0.3 / (0.18 + r)
			ps.vx[i] += (-y * inv_r * swirl * falloff - x * inv_r * pull) * dt
			ps.vy[i] += (x * inv_r * swirl * falloff - y * inv_r * pull) * dt
		}
	}

	// Pass 2: drag + integration.
	drag_base: f32
	switch params.mode {
	case .Fountain:
		drag_base = 0.998
	case .Fireworks:
		drag_base = 0.984
	case .Vortex:
		drag_base = 0.995
	}
	drag := math.pow(drag_base, dt * 60.0)
	for i in 0 ..< len(ps) {
		ps.vx[i] *= drag
		ps.vy[i] *= drag
		ps.x[i] += ps.vx[i] * dt
		ps.y[i] += ps.vy[i] * dt
	}

	// Pass 3: aging.
	for i in 0 ..< len(ps) {
		ps.life[i] -= dt
	}

	// Pass 4: compaction. Dead or out-of-bounds particles are swap-removed so
	// the live set stays contiguous at the front of every field array.
	bound_x := aspect * 1.4
	i := 0
	for i < sim.alive {
		dead :=
			sim.particles[i].life <= 0 ||
			sim.particles[i].y < -1.3 ||
			sim.particles[i].y > 1.4 ||
			abs(sim.particles[i].x) > bound_x
		if dead {
			sim.alive -= 1
			sim.particles[i] = sim.particles[sim.alive]
		} else {
			i += 1
		}
	}
}

// Cosine palette (ember/plasma tones).
palette :: proc(t: f32) -> [3]f32 {
	a := [3]f32{0.54, 0.36, 0.30}
	b := [3]f32{0.46, 0.40, 0.44}
	c := [3]f32{1.00, 0.92, 0.72}
	d := [3]f32{0.04, 0.26, 0.55}
	result: [3]f32
	for j in 0 ..< 3 {
		result[j] = a[j] + b[j] * math.cos(math.TAU * (c[j] * t + d[j]))
	}
	return result
}

FLOATS_PER_INSTANCE :: 8
INSTANCE_STRIDE :: FLOATS_PER_INSTANCE * size_of(f32)

// Pack the live #soa data into the flat per-instance vertex stream:
// clip-space center (vec2), clip-space half extents (vec2), color (vec4).
pack_instances :: proc(sim: ^Sim, out: []f32, aspect: f32) -> int {
	ps := sim.particles[:sim.alive]
	inv_aspect := 1.0 / aspect
	for i in 0 ..< len(ps) {
		t := clamp(ps.life[i] / max(ps.lifespan[i], 0.001), 0, 1)
		fade := t * t * (3.0 - 2.0 * t)
		color := palette(ps.hue[i])
		base := i * FLOATS_PER_INSTANCE
		out[base + 0] = ps.x[i] * inv_aspect
		out[base + 1] = ps.y[i]
		out[base + 2] = ps.size[i] * inv_aspect
		out[base + 3] = ps.size[i]
		out[base + 4] = color[0]
		out[base + 5] = color[1]
		out[base + 6] = color[2]
		out[base + 7] = fade
	}
	return sim.alive
}

// ---------------------------------------------------------------------------
// WGSL shader: instanced quads, soft point sprites, additive blending
// ---------------------------------------------------------------------------

PARTICLE_SHADER: string : `
struct VSOut {
  @builtin(position) position : vec4<f32>,
  @location(0) local : vec2<f32>,
  @location(1) color : vec4<f32>,
};

@vertex
fn vs_main(
  @location(0) corner : vec2<f32>,
  @location(1) center : vec2<f32>,
  @location(2) size : vec2<f32>,
  @location(3) color : vec4<f32>,
) -> VSOut {
  var out : VSOut;
  out.position = vec4<f32>(center + corner * size, 0.0, 1.0);
  out.local = corner;
  out.color = color;
  return out;
}

@fragment
fn fs_main(
  @location(0) local : vec2<f32>,
  @location(1) color : vec4<f32>,
) -> @location(0) vec4<f32> {
  let d2 = dot(local, local);
  if (d2 > 1.0) {
    discard;
  }
  let core = exp(-d2 * 5.5);
  let halo = pow(max(1.0 - sqrt(d2), 0.0), 2.4) * 0.32;
  let intensity = (core + halo) * color.a;
  return vec4<f32>(color.rgb * intensity, intensity);
}
`

// ---------------------------------------------------------------------------
// Dawn webgpu C ABI: enum values and struct layouts
// (identical to the byte layouts templates/zig-wgpu builds by hand)
// ---------------------------------------------------------------------------

SURFACE_FORMAT :: u32(0x0000001c) // BGRA8Unorm
WGPU_STRLEN :: u64(0xffffffffffffffff)
STYPE_SHADER_SOURCE_WGSL :: u32(0x00000002)
TEXTURE_USAGE_RENDER_ATTACHMENT :: u64(0x0000000000000010)
COMPOSITE_ALPHA_MODE_OPAQUE :: u32(0x00000001)
PRESENT_MODE_FIFO :: u32(0x00000001)
VERTEX_FORMAT_FLOAT32X2 :: u32(0x0000001d)
VERTEX_FORMAT_FLOAT32X4 :: u32(0x0000001f)
VERTEX_STEP_MODE_VERTEX :: u32(0x00000001)
VERTEX_STEP_MODE_INSTANCE :: u32(0x00000002)
PRIMITIVE_TOPOLOGY_TRIANGLE_LIST :: u32(0x00000004)
FRONT_FACE_CCW :: u32(0x00000001)
CULL_MODE_NONE :: u32(0x00000001)
COLOR_WRITE_MASK_ALL :: u64(0x000000000000000f)
BLEND_OPERATION_ADD :: u32(0x00000001)
BLEND_FACTOR_ONE :: u32(0x00000002)
BUFFER_USAGE_COPY_DST :: u64(0x0000000000000008)
BUFFER_USAGE_VERTEX :: u64(0x0000000000000020)
LOAD_OP_CLEAR :: u32(0x00000002)
STORE_OP_STORE :: u32(0x00000001)
DEPTH_SLICE_UNDEFINED :: u32(0xffffffff)

Wgpu_String_View :: struct {
	data:   rawptr,
	length: u64,
}

Wgpu_Shader_Source_WGSL :: struct {
	next_in_chain: rawptr,
	s_type:        u32,
	code:          Wgpu_String_View,
}

Wgpu_Shader_Module_Descriptor :: struct {
	next_in_chain: rawptr,
	label:         Wgpu_String_View,
}

Wgpu_Vertex_Attribute :: struct {
	next_in_chain:   rawptr,
	format:          u32,
	offset:          u64,
	shader_location: u32,
}

Wgpu_Vertex_Buffer_Layout :: struct {
	next_in_chain:   rawptr,
	step_mode:       u32,
	array_stride:    u64,
	attribute_count: u64,
	attributes:      [^]Wgpu_Vertex_Attribute,
}

Wgpu_Blend_Component :: struct {
	operation:  u32,
	src_factor: u32,
	dst_factor: u32,
}

Wgpu_Blend_State :: struct {
	color: Wgpu_Blend_Component,
	alpha: Wgpu_Blend_Component,
}

Wgpu_Color_Target_State :: struct {
	next_in_chain: rawptr,
	format:        u32,
	blend:         ^Wgpu_Blend_State,
	write_mask:    u64,
}

Wgpu_Vertex_State :: struct {
	next_in_chain:  rawptr,
	module:         rawptr,
	entry_point:    Wgpu_String_View,
	constant_count: u64,
	constants:      rawptr,
	buffer_count:   u64,
	buffers:        [^]Wgpu_Vertex_Buffer_Layout,
}

Wgpu_Fragment_State :: struct {
	next_in_chain:  rawptr,
	module:         rawptr,
	entry_point:    Wgpu_String_View,
	constant_count: u64,
	constants:      rawptr,
	target_count:   u64,
	targets:        [^]Wgpu_Color_Target_State,
}

Wgpu_Primitive_State :: struct {
	next_in_chain:      rawptr,
	topology:           u32,
	strip_index_format: u32,
	front_face:         u32,
	cull_mode:          u32,
	unclipped_depth:    b32,
}

Wgpu_Multisample_State :: struct {
	next_in_chain:               rawptr,
	count:                       u32,
	mask:                        u32,
	alpha_to_coverage_enabled:   b32,
}

Wgpu_Render_Pipeline_Descriptor :: struct {
	next_in_chain: rawptr,
	label:         Wgpu_String_View,
	layout:        rawptr,
	vertex:        Wgpu_Vertex_State,
	primitive:     Wgpu_Primitive_State,
	depth_stencil: rawptr,
	multisample:   Wgpu_Multisample_State,
	fragment:      ^Wgpu_Fragment_State,
}

Wgpu_Buffer_Descriptor :: struct {
	next_in_chain:      rawptr,
	label:              Wgpu_String_View,
	usage:              u64,
	size:               u64,
	mapped_at_creation: b32,
}

Wgpu_Surface_Configuration :: struct {
	next_in_chain:     rawptr,
	device:            rawptr,
	format:            u32,
	usage:             u64,
	width:             u32,
	height:            u32,
	view_format_count: u64,
	view_formats:      rawptr,
	alpha_mode:        u32,
	present_mode:      u32,
}

Wgpu_Surface_Texture :: struct {
	next_in_chain: rawptr,
	texture:       rawptr,
	status:        u32,
}

Wgpu_Color :: struct {
	r, g, b, a: f64,
}

Wgpu_Render_Pass_Color_Attachment :: struct {
	next_in_chain:  rawptr,
	view:           rawptr,
	depth_slice:    u32,
	resolve_target: rawptr,
	load_op:        u32,
	store_op:       u32,
	clear_value:    Wgpu_Color,
}

Wgpu_Render_Pass_Descriptor :: struct {
	next_in_chain:            rawptr,
	label:                    Wgpu_String_View,
	color_attachment_count:   u64,
	color_attachments:        [^]Wgpu_Render_Pass_Color_Attachment,
	depth_stencil_attachment: rawptr,
	occlusion_query_set:      rawptr,
	timestamp_writes:         rawptr,
}

// Lock the layouts to the exact byte offsets the zig template writes by hand
// (Dawn's webgpu.h with 64-bit flags / string views).
#assert(size_of(Wgpu_Shader_Source_WGSL) == 32)
#assert(size_of(Wgpu_Shader_Module_Descriptor) == 24)
#assert(size_of(Wgpu_Vertex_Attribute) == 32)
#assert(size_of(Wgpu_Vertex_Buffer_Layout) == 40)
#assert(size_of(Wgpu_Blend_State) == 24)
#assert(size_of(Wgpu_Color_Target_State) == 32)
#assert(size_of(Wgpu_Vertex_State) == 64)
#assert(size_of(Wgpu_Fragment_State) == 64)
#assert(size_of(Wgpu_Primitive_State) == 32)
#assert(size_of(Wgpu_Multisample_State) == 24)
#assert(size_of(Wgpu_Render_Pipeline_Descriptor) == 168)
#assert(offset_of(Wgpu_Render_Pipeline_Descriptor, vertex) == 32)
#assert(offset_of(Wgpu_Render_Pipeline_Descriptor, primitive) == 96)
#assert(offset_of(Wgpu_Render_Pipeline_Descriptor, multisample) == 136)
#assert(offset_of(Wgpu_Render_Pipeline_Descriptor, fragment) == 160)
#assert(size_of(Wgpu_Buffer_Descriptor) == 48)
#assert(size_of(Wgpu_Surface_Configuration) == 64)
#assert(offset_of(Wgpu_Surface_Configuration, usage) == 24)
#assert(size_of(Wgpu_Surface_Texture) == 24)
#assert(size_of(Wgpu_Render_Pass_Color_Attachment) == 72)
#assert(offset_of(Wgpu_Render_Pass_Color_Attachment, clear_value) == 40)
#assert(size_of(Wgpu_Render_Pass_Descriptor) == 64)
#assert(offset_of(Wgpu_Render_Pass_Descriptor, color_attachments) == 32)

string_view :: proc(s: string) -> Wgpu_String_View {
	return {data = raw_data(s), length = u64(len(s))}
}

// ---------------------------------------------------------------------------
// Extra Dawn symbols. The SDK's WgpuSymbols only exposes wgpuCreateInstance
// and wgpuDeviceGetQueue, so we look up the remaining C entry points from the
// same loaded library handle (exactly the set the zig template uses).
// ---------------------------------------------------------------------------

Create_Fn :: proc "c" (rawptr, rawptr) -> rawptr
Release_Fn :: proc "c" (rawptr)
Set_Pipeline_Fn :: proc "c" (rawptr, rawptr)
Set_Vertex_Buffer_Fn :: proc "c" (rawptr, u32, rawptr, u64, u64)
Draw_Fn :: proc "c" (rawptr, u32, u32, u32, u32)
End_Fn :: proc "c" (rawptr)
Queue_Write_Buffer_Fn :: proc "c" (rawptr, rawptr, u64, rawptr, u64)
Queue_Submit_Fn :: proc "c" (rawptr, u64, rawptr)
Process_Events_Fn :: proc "c" (rawptr)

Wgpu_Api :: struct {
	device_create_shader_module:      Create_Fn,
	device_create_render_pipeline:    Create_Fn,
	device_create_buffer:             Create_Fn,
	device_create_command_encoder:    Create_Fn,
	texture_create_view:              Create_Fn,
	command_encoder_begin_render_pass: Create_Fn,
	render_pass_encoder_set_pipeline: Set_Pipeline_Fn,
	render_pass_encoder_set_vertex_buffer: Set_Vertex_Buffer_Fn,
	render_pass_encoder_draw:         Draw_Fn,
	render_pass_encoder_end:          End_Fn,
	command_encoder_finish:           Create_Fn,
	queue_write_buffer:               Queue_Write_Buffer_Fn,
	queue_submit:                     Queue_Submit_Fn,
	instance_process_events:          Process_Events_Fn,
	texture_release:                  Release_Fn,
	texture_view_release:             Release_Fn,
	command_buffer_release:           Release_Fn,
	command_encoder_release:          Release_Fn,
}

wgpu_symbol :: proc(lib: dynlib.Library, name: string) -> (rawptr, bool) {
	ptr, found := dynlib.symbol_address(lib, name)
	if !found {
		fmt.eprintf("[odin-particles] missing wgpu symbol: %s\n", name)
	}
	return ptr, found
}

wgpu_api_load :: proc(native: ^electrobun.WgpuNative) -> (api: Wgpu_Api, ok: bool) {
	lib := native.symbols.__handle

	p: rawptr
	p = wgpu_symbol(lib, "wgpuDeviceCreateShaderModule") or_return
	api.device_create_shader_module = cast(Create_Fn)p
	p = wgpu_symbol(lib, "wgpuDeviceCreateRenderPipeline") or_return
	api.device_create_render_pipeline = cast(Create_Fn)p
	p = wgpu_symbol(lib, "wgpuDeviceCreateBuffer") or_return
	api.device_create_buffer = cast(Create_Fn)p
	p = wgpu_symbol(lib, "wgpuDeviceCreateCommandEncoder") or_return
	api.device_create_command_encoder = cast(Create_Fn)p
	p = wgpu_symbol(lib, "wgpuTextureCreateView") or_return
	api.texture_create_view = cast(Create_Fn)p
	p = wgpu_symbol(lib, "wgpuCommandEncoderBeginRenderPass") or_return
	api.command_encoder_begin_render_pass = cast(Create_Fn)p
	p = wgpu_symbol(lib, "wgpuRenderPassEncoderSetPipeline") or_return
	api.render_pass_encoder_set_pipeline = cast(Set_Pipeline_Fn)p
	p = wgpu_symbol(lib, "wgpuRenderPassEncoderSetVertexBuffer") or_return
	api.render_pass_encoder_set_vertex_buffer = cast(Set_Vertex_Buffer_Fn)p
	p = wgpu_symbol(lib, "wgpuRenderPassEncoderDraw") or_return
	api.render_pass_encoder_draw = cast(Draw_Fn)p
	p = wgpu_symbol(lib, "wgpuRenderPassEncoderEnd") or_return
	api.render_pass_encoder_end = cast(End_Fn)p
	p = wgpu_symbol(lib, "wgpuCommandEncoderFinish") or_return
	api.command_encoder_finish = cast(Create_Fn)p
	p = wgpu_symbol(lib, "wgpuQueueWriteBuffer") or_return
	api.queue_write_buffer = cast(Queue_Write_Buffer_Fn)p
	p = wgpu_symbol(lib, "wgpuQueueSubmit") or_return
	api.queue_submit = cast(Queue_Submit_Fn)p
	p = wgpu_symbol(lib, "wgpuInstanceProcessEvents") or_return
	api.instance_process_events = cast(Process_Events_Fn)p
	p = wgpu_symbol(lib, "wgpuTextureRelease") or_return
	api.texture_release = cast(Release_Fn)p
	p = wgpu_symbol(lib, "wgpuTextureViewRelease") or_return
	api.texture_view_release = cast(Release_Fn)p
	p = wgpu_symbol(lib, "wgpuCommandBufferRelease") or_return
	api.command_buffer_release = cast(Release_Fn)p
	p = wgpu_symbol(lib, "wgpuCommandEncoderRelease") or_return
	api.command_encoder_release = cast(Release_Fn)p

	return api, true
}

// ---------------------------------------------------------------------------
// App / GPU shared state
// ---------------------------------------------------------------------------

Gpu_Shared :: struct {
	mutex:           sync.Mutex,
	view_id:         u32,
	host_webview_id: u32,
	width:           u32,
	height:          u32,
	running:         bool,
	reset_requested: bool,
	params:          Sim_Params,
}

App_State :: struct {
	core:         ^electrobun.Core,
	bundle_paths: ^electrobun.BundlePaths,
	mutex:        sync.Mutex,
	webview_id:   u32,
	gpu:          Gpu_Shared,
}

g_state: ^App_State
g_queue_running: bool
g_gpu_thread_started: bool

app_state :: proc() -> ^App_State {
	if g_state == nil {
		panic("odin-particles state not initialized")
	}
	return g_state
}

// ---------------------------------------------------------------------------
// Pipeline creation and per-frame rendering
// ---------------------------------------------------------------------------

CORNER_VERTEX_COUNT :: 6
CORNER_STRIDE :: 2 * size_of(f32)
CORNER_BUFFER_SIZE :: CORNER_VERTEX_COUNT * CORNER_STRIDE
INSTANCE_BUFFER_SIZE :: MAX_PARTICLES * INSTANCE_STRIDE

Gpu_Pipeline :: struct {
	pipeline:        rawptr,
	corner_buffer:   rawptr,
	instance_buffer: rawptr,
}

create_particle_pipeline :: proc(
	api: Wgpu_Api,
	ctx: electrobun.WgpuContext,
	queue: rawptr,
) -> (
	pipeline: Gpu_Pipeline,
	ok: bool,
) {
	shader_code := PARTICLE_SHADER
	shader_source := Wgpu_Shader_Source_WGSL {
		s_type = STYPE_SHADER_SOURCE_WGSL,
		code   = string_view(shader_code),
	}
	shader_descriptor := Wgpu_Shader_Module_Descriptor {
		next_in_chain = &shader_source,
	}
	shader_module := api.device_create_shader_module(ctx.device_ptr, &shader_descriptor)
	if shader_module == nil {
		fmt.eprintln("[odin-particles] failed to create shader module")
		return {}, false
	}

	corner_attributes := [1]Wgpu_Vertex_Attribute{
		{format = VERTEX_FORMAT_FLOAT32X2, offset = 0, shader_location = 0},
	}
	instance_attributes := [3]Wgpu_Vertex_Attribute{
		{format = VERTEX_FORMAT_FLOAT32X2, offset = 0, shader_location = 1},
		{format = VERTEX_FORMAT_FLOAT32X2, offset = 8, shader_location = 2},
		{format = VERTEX_FORMAT_FLOAT32X4, offset = 16, shader_location = 3},
	}
	buffer_layouts := [2]Wgpu_Vertex_Buffer_Layout{
		{
			step_mode = VERTEX_STEP_MODE_VERTEX,
			array_stride = CORNER_STRIDE,
			attribute_count = 1,
			attributes = &corner_attributes[0],
		},
		{
			step_mode = VERTEX_STEP_MODE_INSTANCE,
			array_stride = INSTANCE_STRIDE,
			attribute_count = 3,
			attributes = &instance_attributes[0],
		},
	}

	// Additive blending: every particle adds light into the frame.
	blend := Wgpu_Blend_State {
		color = {operation = BLEND_OPERATION_ADD, src_factor = BLEND_FACTOR_ONE, dst_factor = BLEND_FACTOR_ONE},
		alpha = {operation = BLEND_OPERATION_ADD, src_factor = BLEND_FACTOR_ONE, dst_factor = BLEND_FACTOR_ONE},
	}
	color_target := Wgpu_Color_Target_State {
		format     = SURFACE_FORMAT,
		blend      = &blend,
		write_mask = COLOR_WRITE_MASK_ALL,
	}
	fragment_state := Wgpu_Fragment_State {
		module       = shader_module,
		entry_point  = string_view("fs_main"),
		target_count = 1,
		targets      = &color_target,
	}

	pipeline_descriptor := Wgpu_Render_Pipeline_Descriptor {
		vertex = {
			module = shader_module,
			entry_point = string_view("vs_main"),
			buffer_count = 2,
			buffers = &buffer_layouts[0],
		},
		primitive = {
			topology = PRIMITIVE_TOPOLOGY_TRIANGLE_LIST,
			front_face = FRONT_FACE_CCW,
			cull_mode = CULL_MODE_NONE,
		},
		multisample = {count = 1, mask = 0xffffffff},
		fragment = &fragment_state,
	}

	pipeline.pipeline = api.device_create_render_pipeline(ctx.device_ptr, &pipeline_descriptor)
	if pipeline.pipeline == nil {
		fmt.eprintln("[odin-particles] failed to create render pipeline")
		return {}, false
	}

	corner_descriptor := Wgpu_Buffer_Descriptor {
		usage = BUFFER_USAGE_VERTEX | BUFFER_USAGE_COPY_DST,
		size  = CORNER_BUFFER_SIZE,
	}
	pipeline.corner_buffer = api.device_create_buffer(ctx.device_ptr, &corner_descriptor)
	if pipeline.corner_buffer == nil {
		fmt.eprintln("[odin-particles] failed to create corner buffer")
		return {}, false
	}

	instance_descriptor := Wgpu_Buffer_Descriptor {
		usage = BUFFER_USAGE_VERTEX | BUFFER_USAGE_COPY_DST,
		size  = INSTANCE_BUFFER_SIZE,
	}
	pipeline.instance_buffer = api.device_create_buffer(ctx.device_ptr, &instance_descriptor)
	if pipeline.instance_buffer == nil {
		fmt.eprintln("[odin-particles] failed to create instance buffer")
		return {}, false
	}

	// Two CCW triangles covering the unit quad.
	corners := [CORNER_VERTEX_COUNT * 2]f32{
		-1, -1, 1, -1, 1, 1,
		-1, -1, 1, 1, -1, 1,
	}
	api.queue_write_buffer(queue, pipeline.corner_buffer, 0, &corners, CORNER_BUFFER_SIZE)

	return pipeline, true
}

configure_surface :: proc(
	core: ^electrobun.Core,
	ctx: electrobun.WgpuContext,
	width: u32,
	height: u32,
) -> electrobun.Error {
	config := Wgpu_Surface_Configuration {
		device       = ctx.device_ptr,
		format       = SURFACE_FORMAT,
		usage        = TEXTURE_USAGE_RENDER_ATTACHMENT,
		width        = width,
		height       = height,
		alpha_mode   = COMPOSITE_ALPHA_MODE_OPAQUE,
		present_mode = PRESENT_MODE_FIFO,
	}
	return electrobun.wgpuSurfaceConfigureMainThread(core, ctx.surface_ptr, &config)
}

render_frame :: proc(
	core: ^electrobun.Core,
	api: Wgpu_Api,
	ctx: electrobun.WgpuContext,
	pipeline: Gpu_Pipeline,
	queue: rawptr,
	instance_data: []f32,
	instance_count: int,
) -> bool {
	api.instance_process_events(ctx.instance_ptr)

	if instance_count > 0 {
		api.queue_write_buffer(
			queue,
			pipeline.instance_buffer,
			0,
			raw_data(instance_data),
			u64(instance_count * INSTANCE_STRIDE),
		)
	}

	surface_texture: Wgpu_Surface_Texture
	if electrobun.wgpuSurfaceGetCurrentTextureMainThread(core, ctx.surface_ptr, &surface_texture) != .None {
		return false
	}
	// 1 = SuccessOptimal, 2 = SuccessSuboptimal
	if (surface_texture.status != 1 && surface_texture.status != 2) || surface_texture.texture == nil {
		return false
	}
	defer api.texture_release(surface_texture.texture)

	texture_view := api.texture_create_view(surface_texture.texture, nil)
	if texture_view == nil {
		return false
	}
	defer api.texture_view_release(texture_view)

	encoder := api.device_create_command_encoder(ctx.device_ptr, nil)
	if encoder == nil {
		return false
	}
	defer api.command_encoder_release(encoder)

	color_attachment := Wgpu_Render_Pass_Color_Attachment {
		view        = texture_view,
		depth_slice = DEPTH_SLICE_UNDEFINED,
		load_op     = LOAD_OP_CLEAR,
		store_op    = STORE_OP_STORE,
		clear_value = {0.004, 0.005, 0.010, 1.0},
	}
	pass_descriptor := Wgpu_Render_Pass_Descriptor {
		color_attachment_count = 1,
		color_attachments      = &color_attachment,
	}

	pass := api.command_encoder_begin_render_pass(encoder, &pass_descriptor)
	if pass == nil {
		return false
	}
	api.render_pass_encoder_set_pipeline(pass, pipeline.pipeline)
	api.render_pass_encoder_set_vertex_buffer(pass, 0, pipeline.corner_buffer, 0, CORNER_BUFFER_SIZE)
	api.render_pass_encoder_set_vertex_buffer(pass, 1, pipeline.instance_buffer, 0, INSTANCE_BUFFER_SIZE)
	if instance_count > 0 {
		api.render_pass_encoder_draw(pass, CORNER_VERTEX_COUNT, u32(instance_count), 0, 0)
	}
	api.render_pass_encoder_end(pass)

	command_buffer := api.command_encoder_finish(encoder, nil)
	if command_buffer == nil {
		return false
	}
	defer api.command_buffer_release(command_buffer)

	commands := [1]rawptr{command_buffer}
	api.queue_submit(queue, 1, &commands)
	_, present_err := electrobun.wgpuSurfacePresentMainThread(core, ctx.surface_ptr)
	return present_err == .None
}

// ---------------------------------------------------------------------------
// GPU thread: simulate + render at ~60fps
// ---------------------------------------------------------------------------

send_gpu_frame :: proc(webview_id: u32, view_id: u32, frame: u64, width: u32, height: u32, alive: int) {
	state := app_state()
	_ = electrobun.sendHostMessageToWebview(
		state.core,
		webview_id,
		struct {
			type:    string,
			id:      string,
			payload: struct {
				id:     u32,
				frame:  u64,
				width:  u32,
				height: u32,
				alive:  int,
			},
		}{
			type = "message",
			id = "gpuFrame",
			payload = {id = view_id, frame = frame, width = width, height = height, alive = alive},
		},
	)
}

gpu_render_loop :: proc() {
	state := app_state()

	native, native_err := electrobun.wgpuNativeLoad()
	if native_err != .None {
		fmt.eprintfln("[odin-particles] failed to load WGPU library: %v", native_err)
		return
	}
	defer electrobun.close(&native)

	api, api_ok := wgpu_api_load(&native)
	if !api_ok {
		return
	}

	sim := new(Sim)
	defer free(sim)
	sim_reset(sim)

	instance_data := make([]f32, MAX_PARTICLES * FLOATS_PER_INSTANCE)
	defer delete(instance_data)

	active_view_id: u32
	ctx: electrobun.WgpuContext
	has_context := false
	pipeline: Gpu_Pipeline
	queue: rawptr
	configured_width: u32
	configured_height: u32
	frame: u64

	DT :: f32(1.0 / 60.0)

	for intrinsics.atomic_load(&g_queue_running) {
		sync.mutex_lock(&state.gpu.mutex)
		running := state.gpu.running
		view_id := state.gpu.view_id
		host_webview_id := state.gpu.host_webview_id
		width := state.gpu.width
		height := state.gpu.height
		params := state.gpu.params
		reset_requested := state.gpu.reset_requested
		state.gpu.reset_requested = false
		sync.mutex_unlock(&state.gpu.mutex)

		if !running || view_id == 0 {
			time.sleep(16 * time.Millisecond)
			continue
		}

		if reset_requested {
			sim_reset(sim)
		}

		if !has_context || active_view_id != view_id {
			new_ctx, ctx_err := electrobun.createForWgpuView(state.core, &native, view_id)
			if ctx_err != .None {
				fmt.eprintfln("[odin-particles] failed to create WGPU context: %v", ctx_err)
				time.sleep(250 * time.Millisecond)
				continue
			}
			ctx = new_ctx
			queue = electrobun.getQueue(ctx, &native)
			if queue == nil {
				fmt.eprintln("[odin-particles] failed to get WGPU queue")
				time.sleep(250 * time.Millisecond)
				continue
			}
			new_pipeline, pipeline_ok := create_particle_pipeline(api, ctx, queue)
			if !pipeline_ok {
				time.sleep(250 * time.Millisecond)
				continue
			}
			pipeline = new_pipeline
			has_context = true
			active_view_id = view_id
			configured_width = 0
			configured_height = 0
			fmt.printfln("[odin-particles] WGPU context ready for view %d", view_id)
		}

		if configured_width != width || configured_height != height {
			if configure_surface(state.core, ctx, width, height) != .None {
				fmt.eprintln("[odin-particles] failed to configure surface")
				time.sleep(250 * time.Millisecond)
				continue
			}
			configured_width = width
			configured_height = height
		}

		aspect := f32(width) / max(f32(height), 1)

		if !params.paused {
			sim_update(sim, params, DT, aspect)
		}
		instance_count := pack_instances(sim, instance_data, aspect)

		if !render_frame(state.core, api, ctx, pipeline, queue, instance_data, instance_count) {
			time.sleep(100 * time.Millisecond)
			continue
		}

		if frame % 30 == 0 && host_webview_id != 0 {
			send_gpu_frame(host_webview_id, view_id, frame, width, height, sim.alive)
		}

		frame += 1
		time.sleep(16 * time.Millisecond)
	}
}

ensure_gpu_thread :: proc() {
	if intrinsics.atomic_exchange(&g_gpu_thread_started, true) {
		return
	}
	thread.create_and_start(gpu_render_loop, self_cleanup = true)
}

// ---------------------------------------------------------------------------
// RPC: JSON helpers + request handling (mirrors zig-wgpu's host-message RPC)
// ---------------------------------------------------------------------------

obj_string :: proc(obj: json.Object, name: string) -> (string, bool) {
	value, found := obj[name]
	if !found {
		return "", false
	}
	s, is_string := value.(json.String)
	if !is_string {
		return "", false
	}
	return s, true
}

obj_f64 :: proc(obj: json.Object, name: string, fallback: f64) -> f64 {
	value, found := obj[name]
	if !found {
		return fallback
	}
	#partial switch v in value {
	case json.Integer:
		return f64(v)
	case json.Float:
		return f64(v)
	}
	return fallback
}

obj_u32 :: proc(obj: json.Object, name: string, fallback: u32) -> u32 {
	value := obj_f64(obj, name, f64(fallback))
	if value < 0 {
		return fallback
	}
	return u32(min(value, f64(max(u32))))
}

obj_bool :: proc(obj: json.Object, name: string, fallback: bool) -> bool {
	value, found := obj[name]
	if !found {
		return fallback
	}
	v, is_bool := value.(json.Boolean)
	if !is_bool {
		return fallback
	}
	return v
}

rect_dimension :: proc(params: json.Object, name: string, fallback: u32) -> u32 {
	rect_value, found := params["rect"]
	if !found {
		return fallback
	}
	rect, is_object := rect_value.(json.Object)
	if !is_object {
		return fallback
	}
	return clamp(obj_u32(rect, name, fallback), 1, 4096)
}

send_rpc_success :: proc(webview_id: u32, request_id: u64) {
	state := app_state()
	err := electrobun.sendHostMessageToWebview(
		state.core,
		webview_id,
		struct {
			type:    string,
			id:      u64,
			success: bool,
			payload: struct {
				ok: bool,
			},
		}{type = "response", id = request_id, success = true, payload = {ok = true}},
	)
	if err != .None {
		fmt.eprintfln("[odin-particles] failed to send response: %v", err)
	}
}

send_rpc_error :: proc(webview_id: u32, request_id: u64, message: string) {
	state := app_state()
	err := electrobun.sendHostMessageToWebview(
		state.core,
		webview_id,
		struct {
			type:    string,
			id:      u64,
			success: bool,
			error:   string,
		}{type = "response", id = request_id, success = false, error = message},
	)
	if err != .None {
		fmt.eprintfln("[odin-particles] failed to send error response: %v", err)
	}
}

configure_gpu_from_params :: proc(state: ^App_State, webview_id: u32, params: json.Object) -> bool {
	view_id := obj_u32(params, "id", 0)
	if view_id == 0 {
		return false
	}

	sync.mutex_lock(&state.gpu.mutex)
	defer sync.mutex_unlock(&state.gpu.mutex)
	state.gpu.view_id = view_id
	state.gpu.host_webview_id = webview_id
	state.gpu.width = rect_dimension(params, "width", state.gpu.width)
	state.gpu.height = rect_dimension(params, "height", state.gpu.height)
	state.gpu.params.mode = Emitter_Mode(min(obj_u32(params, "mode", u32(state.gpu.params.mode)), 2))
	state.gpu.params.target = int(
		clamp(obj_u32(params, "count", u32(state.gpu.params.target)), 1000, MAX_PARTICLES),
	)
	state.gpu.params.gravity = clamp(f32(obj_f64(params, "gravity", f64(state.gpu.params.gravity) * 100)) / 100, 0, 1)
	state.gpu.params.force = clamp(f32(obj_f64(params, "force", f64(state.gpu.params.force) * 100)) / 100, 0, 1)
	state.gpu.params.paused = obj_bool(params, "paused", state.gpu.params.paused)
	return true
}

handle_rpc_request :: proc(webview_id: u32, request_id: u64, method: string, params: json.Value) {
	state := app_state()

	params_obj, params_is_object := params.(json.Object)

	switch method {
	case "startGpu":
		if !params_is_object || !configure_gpu_from_params(state, webview_id, params_obj) {
			send_rpc_error(webview_id, request_id, "InvalidParams")
			return
		}
		sync.mutex_lock(&state.gpu.mutex)
		state.gpu.running = true
		started_view_id := state.gpu.view_id
		sync.mutex_unlock(&state.gpu.mutex)
		fmt.printfln("[odin-particles] starting WGPU view %d", started_view_id)
		ensure_gpu_thread()
		send_rpc_success(webview_id, request_id)

	case "configureGpu":
		if !params_is_object || !configure_gpu_from_params(state, webview_id, params_obj) {
			send_rpc_error(webview_id, request_id, "InvalidParams")
			return
		}
		send_rpc_success(webview_id, request_id)

	case "resetSim":
		sync.mutex_lock(&state.gpu.mutex)
		state.gpu.reset_requested = true
		sync.mutex_unlock(&state.gpu.mutex)
		send_rpc_success(webview_id, request_id)

	case:
		send_rpc_error(webview_id, request_id, "Unknown RPC request")
	}
}

handle_host_message :: proc(webview_id: u32, message: cstring) {
	message_str := string(message)
	if len(message_str) == 0 {
		return
	}

	value, parse_err := json.parse_string(message_str, json.DEFAULT_SPECIFICATION, true)
	if parse_err != .None {
		fmt.eprintfln("[odin-particles] failed to parse RPC packet: %v", parse_err)
		return
	}
	defer json.destroy_value(value)

	obj, is_object := value.(json.Object)
	if !is_object {
		return
	}
	packet_type, type_ok := obj_string(obj, "type")
	if !type_ok || packet_type != "request" {
		return
	}

	id_value, id_found := obj["id"]
	if !id_found {
		return
	}
	request_id: u64
	#partial switch v in id_value {
	case json.Integer:
		if v < 0 {
			return
		}
		request_id = u64(v)
	case:
		return
	}

	method, method_ok := obj_string(obj, "method")
	if !method_ok {
		return
	}
	handle_rpc_request(webview_id, request_id, method, obj["params"])
}

drain_host_message_queue :: proc() {
	for intrinsics.atomic_load(&g_queue_running) {
		state := g_state
		if state == nil {
			time.sleep(10 * time.Millisecond)
			continue
		}

		drained_any := false
		for intrinsics.atomic_load(&g_queue_running) {
			webview_id: u32
			message := electrobun.popNextQueuedHostMessage(state.core, &webview_id)
			if message == nil {
				break
			}
			handle_host_message(webview_id, message)
			electrobun.freeCoreString(state.core, message)
			drained_any = true
		}

		if !drained_any {
			time.sleep(10 * time.Millisecond)
		}
	}
}

host_bridge :: proc "c" (webview_id: u32, message: cstring) {
	context = runtime.default_context()
	handle_host_message(webview_id, message)
}

// ---------------------------------------------------------------------------
// UI thread + main
// ---------------------------------------------------------------------------

create_ui :: proc() {
	state := app_state()
	time.sleep(150 * time.Millisecond)

	if err := electrobun.configureWebviewRuntimeFromExecutableDir(state.core, state.bundle_paths, 0);
	   err != .None {
		fmt.eprintfln("[odin-particles] failed to configure webview runtime: %v", err)
		return
	}

	window_options := electrobun.defaultWindowOptions("Odin Particles")
	window_options.frame = {x = 160, y = 100, width = 1080, height = 740}
	window_id, window_err := electrobun.createWindow(state.core, window_options)
	if window_err != .None {
		fmt.eprintfln("[odin-particles] failed to create window: %v", window_err)
		return
	}

	webview_options := electrobun.defaultWebviewOptions(window_id)
	webview_options.url = "views://mainview/index.html"
	webview_options.frame = {x = 0, y = 0, width = 1080, height = 740}
	webview_options.secret_key = DEFAULT_SECRET_KEY
	webview_options.sandbox = false
	webview_options.callbacks = {
		decide_navigation = electrobun.allowAllNavigation,
		event             = electrobun.noopWebviewEvent,
		event_bridge      = electrobun.noopWebviewPostMessage,
		host_bridge       = host_bridge,
	}

	webview_id, webview_err := electrobun.createWebview(state.core, webview_options)
	if webview_err != .None {
		fmt.eprintfln("[odin-particles] failed to create webview: %v", webview_err)
		_ = electrobun.closeWindow(state.core, window_id)
		return
	}

	sync.mutex_lock(&state.mutex)
	state.webview_id = webview_id
	sync.mutex_unlock(&state.mutex)
}

main :: proc() {
	core, core_err := electrobun.load()
	if core_err != .None {
		fmt.eprintfln("[odin-particles] failed to load Electrobun core: %v", core_err)
		return
	}
	defer electrobun.close(&core)

	bundle_paths, bundle_err := electrobun.resolveBundlePaths()
	if bundle_err != .None {
		fmt.eprintfln("[odin-particles] failed to resolve bundle paths: %v", bundle_err)
		return
	}
	defer electrobun.deinit(&bundle_paths, context.allocator)

	owned_app_info, app_info_err := electrobun.resolveAppInfoFromBundle(context.allocator, &bundle_paths)
	if app_info_err != .None {
		fmt.eprintfln("[odin-particles] failed to resolve app info: %v", app_info_err)
		return
	}
	defer electrobun.deinit(&owned_app_info, context.allocator)
	app_info := electrobun.borrowed(owned_app_info)

	state := App_State {
		core         = &core,
		bundle_paths = &bundle_paths,
	}
	state.gpu.params = default_sim_params()
	state.gpu.width = 640
	state.gpu.height = 420

	g_state = &state
	defer g_state = nil

	intrinsics.atomic_store(&g_queue_running, true)
	thread.create_and_start(create_ui, self_cleanup = true)
	thread.create_and_start(drain_host_message_queue, self_cleanup = true)

	defer {
		sync.mutex_lock(&state.gpu.mutex)
		state.gpu.running = false
		sync.mutex_unlock(&state.gpu.mutex)
		intrinsics.atomic_store(&g_queue_running, false)
	}

	if err := electrobun.runMainThread(&core, app_info); err != .None {
		fmt.eprintfln("[odin-particles] main thread exited with error: %v", err)
	}
}
