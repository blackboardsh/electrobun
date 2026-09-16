// Neon Fluid Lab: an allocation-free stable-fluid solver in the Odin main
// process, rendered as one instanced draw on a native <electrobun-wgpu>
// surface. The webview owns layout and input normalization; Odin owns all
// simulation fields, solver passes, pointer effects, and Dawn resources.
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
// Stable-fluid simulation
// ---------------------------------------------------------------------------

MAX_GRID_COLUMNS :: 144
MAX_GRID_ROWS :: 112
MAX_CELLS :: MAX_GRID_COLUMNS * MAX_GRID_ROWS
MAX_INPUTS :: 64
SOLVER_ITERATIONS :: 8

Fluid_Tool :: enum u32 {
	Ink    = 0,
	Vortex = 1,
	Heat   = 2,
	Erase  = 3,
}

Fluid_Config :: struct {
	palette:   u32,
	hue:       f32,
	radius:    f32,
	force:     f32,
	swirl:     f32,
	viscosity: f32,
	fade:      f32,
	paused:    bool,
}

default_fluid_config :: proc() -> Fluid_Config {
	return {
		palette = 0,
		hue = 0.54,
		radius = 8,
		force = 0.68,
		swirl = 0.42,
		viscosity = 0.12,
		fade = 0.18,
	}
}

Fluid_Input :: struct {
	x, y:       f32,
	dx, dy:     f32,
	tool:       Fluid_Tool,
	hue:        f32,
	radius:     f32,
	force:      f32,
}

Sim :: struct {
	columns, rows: int,
	u, v:          [MAX_CELLS]f32,
	u_prev, v_prev: [MAX_CELLS]f32,
	pressure:      [MAX_CELLS]f32,
	divergence:    [MAX_CELLS]f32,
	curl:          [MAX_CELLS]f32,
	dye_r, dye_g, dye_b: [MAX_CELLS]f32,
	dye_r_prev, dye_g_prev, dye_b_prev: [MAX_CELLS]f32,
	clock:         f32,
}

grid_index :: proc(x, y: int) -> int {
	return y * MAX_GRID_COLUMNS + x
}

clear_field :: proc(field: []f32) {
	for i in 0 ..< len(field) {
		field[i] = 0
	}
}

sim_clear :: proc(sim: ^Sim) {
	clear_field(sim.u[:])
	clear_field(sim.v[:])
	clear_field(sim.u_prev[:])
	clear_field(sim.v_prev[:])
	clear_field(sim.pressure[:])
	clear_field(sim.divergence[:])
	clear_field(sim.curl[:])
	clear_field(sim.dye_r[:])
	clear_field(sim.dye_g[:])
	clear_field(sim.dye_b[:])
	clear_field(sim.dye_r_prev[:])
	clear_field(sim.dye_g_prev[:])
	clear_field(sim.dye_b_prev[:])
	sim.clock = 0
}

set_boundary :: proc(field: []f32, columns, rows, boundary: int) {
	for x in 1 ..< columns - 1 {
		field[grid_index(x, 0)] = (boundary == 2 ? -field[grid_index(x, 1)] : field[grid_index(x, 1)])
		field[grid_index(x, rows - 1)] = (boundary == 2 ? -field[grid_index(x, rows - 2)] : field[grid_index(x, rows - 2)])
	}
	for y in 1 ..< rows - 1 {
		field[grid_index(0, y)] = (boundary == 1 ? -field[grid_index(1, y)] : field[grid_index(1, y)])
		field[grid_index(columns - 1, y)] = (boundary == 1 ? -field[grid_index(columns - 2, y)] : field[grid_index(columns - 2, y)])
	}
	field[grid_index(0, 0)] = 0.5 * (field[grid_index(1, 0)] + field[grid_index(0, 1)])
	field[grid_index(0, rows - 1)] = 0.5 * (field[grid_index(1, rows - 1)] + field[grid_index(0, rows - 2)])
	field[grid_index(columns - 1, 0)] = 0.5 * (field[grid_index(columns - 2, 0)] + field[grid_index(columns - 1, 1)])
	field[grid_index(columns - 1, rows - 1)] = 0.5 * (field[grid_index(columns - 2, rows - 1)] + field[grid_index(columns - 1, rows - 2)])
}

diffuse :: proc(destination, source: []f32, diffusion, dt: f32, columns, rows, boundary: int) {
	a := dt * diffusion * f32((columns - 2) * (rows - 2))
	denominator := 1.0 + 4.0 * a
	for _ in 0 ..< SOLVER_ITERATIONS {
		for y in 1 ..< rows - 1 {
			for x in 1 ..< columns - 1 {
				i := grid_index(x, y)
				destination[i] = (
					source[i] + a * (
						destination[grid_index(x - 1, y)] +
						destination[grid_index(x + 1, y)] +
						destination[grid_index(x, y - 1)] +
						destination[grid_index(x, y + 1)]
					)
				) / denominator
			}
		}
		set_boundary(destination, columns, rows, boundary)
	}
}

project_velocity :: proc(u, v, pressure, divergence: []f32, columns, rows: int) {
	inv_columns := 1.0 / f32(columns)
	inv_rows := 1.0 / f32(rows)
	for y in 1 ..< rows - 1 {
		for x in 1 ..< columns - 1 {
			i := grid_index(x, y)
			divergence[i] = -0.5 * (
				(u[grid_index(x + 1, y)] - u[grid_index(x - 1, y)]) * inv_columns +
				(v[grid_index(x, y + 1)] - v[grid_index(x, y - 1)]) * inv_rows
			)
			pressure[i] = 0
		}
	}
	set_boundary(divergence, columns, rows, 0)
	set_boundary(pressure, columns, rows, 0)

	for _ in 0 ..< SOLVER_ITERATIONS + 4 {
		for y in 1 ..< rows - 1 {
			for x in 1 ..< columns - 1 {
				i := grid_index(x, y)
				pressure[i] = (
					divergence[i] +
					pressure[grid_index(x - 1, y)] +
					pressure[grid_index(x + 1, y)] +
					pressure[grid_index(x, y - 1)] +
					pressure[grid_index(x, y + 1)]
				) * 0.25
			}
		}
		set_boundary(pressure, columns, rows, 0)
	}

	for y in 1 ..< rows - 1 {
		for x in 1 ..< columns - 1 {
			i := grid_index(x, y)
			u[i] -= 0.5 * f32(columns) * (pressure[grid_index(x + 1, y)] - pressure[grid_index(x - 1, y)])
			v[i] -= 0.5 * f32(rows) * (pressure[grid_index(x, y + 1)] - pressure[grid_index(x, y - 1)])
		}
	}
	set_boundary(u, columns, rows, 1)
	set_boundary(v, columns, rows, 2)
}

advect :: proc(destination, source, u, v: []f32, dt: f32, columns, rows, boundary: int) {
	dt_x := dt * f32(columns - 2)
	dt_y := dt * f32(rows - 2)
	for y in 1 ..< rows - 1 {
		for x in 1 ..< columns - 1 {
			i := grid_index(x, y)
			back_x := clamp(f32(x) - dt_x * u[i], 0.5, f32(columns) - 1.5)
			back_y := clamp(f32(y) - dt_y * v[i], 0.5, f32(rows) - 1.5)
			x0 := int(math.floor(back_x))
			y0 := int(math.floor(back_y))
			x1 := x0 + 1
			y1 := y0 + 1
			sx := back_x - f32(x0)
			sy := back_y - f32(y0)
			destination[i] =
				(1 - sx) * ((1 - sy) * source[grid_index(x0, y0)] + sy * source[grid_index(x0, y1)]) +
				sx * ((1 - sy) * source[grid_index(x1, y0)] + sy * source[grid_index(x1, y1)])
		}
	}
	set_boundary(destination, columns, rows, boundary)
}

apply_vorticity :: proc(sim: ^Sim, amount, dt: f32) {
	if amount <= 0.001 {
		return
	}
	for y in 1 ..< sim.rows - 1 {
		for x in 1 ..< sim.columns - 1 {
			i := grid_index(x, y)
			sim.curl[i] = 0.5 * (
				sim.v[grid_index(x + 1, y)] - sim.v[grid_index(x - 1, y)] -
				sim.u[grid_index(x, y + 1)] + sim.u[grid_index(x, y - 1)]
			)
		}
	}
	strength := 18.0 * amount
	for y in 2 ..< sim.rows - 2 {
		for x in 2 ..< sim.columns - 2 {
			i := grid_index(x, y)
			nx := abs(sim.curl[grid_index(x + 1, y)]) - abs(sim.curl[grid_index(x - 1, y)])
			ny := abs(sim.curl[grid_index(x, y + 1)]) - abs(sim.curl[grid_index(x, y - 1)])
			length := max(math.sqrt(nx * nx + ny * ny), 0.0001)
			nx /= length
			ny /= length
			vorticity := sim.curl[i] * strength
			sim.u[i] += ny * vorticity * dt
			sim.v[i] -= nx * vorticity * dt
		}
	}
}

hsv_to_rgb :: proc(h, saturation, value: f32) -> [3]f32 {
	hue := h - math.floor(h)
	sector := int(math.floor(hue * 6.0)) % 6
	fraction := hue * 6.0 - f32(sector)
	p := value * (1 - saturation)
	q := value * (1 - fraction * saturation)
	t := value * (1 - (1 - fraction) * saturation)
	switch sector {
	case 0: return {value, t, p}
	case 1: return {q, value, p}
	case 2: return {p, value, t}
	case 3: return {p, q, value}
	case 4: return {t, p, value}
	case:   return {value, p, q}
	}
}

palette_color :: proc(palette: u32, hue: f32) -> [3]f32 {
	switch min(palette, 3) {
	case 0: return hsv_to_rgb(hue * 0.58 + 0.36, 0.76, 1.0)
	case 1: return hsv_to_rgb(hue * 0.34 + 0.80, 0.88, 1.0)
	case 2: return hsv_to_rgb(hue * 0.16 + 0.01, 0.92, 1.0)
	case:   return hsv_to_rgb(hue * 0.24 + 0.68, 0.80, 1.0)
	}
}

apply_brush_point :: proc(sim: ^Sim, input: Fluid_Input, palette: u32, px, py: f32) {
	center_x := 1.0 + px * f32(sim.columns - 3)
	center_y := 1.0 + (1.0 - py) * f32(sim.rows - 3)
	radius := clamp(input.radius, 1.5, 20.0)
	min_x := clamp(int(math.floor(center_x - radius)), 1, sim.columns - 2)
	max_x := clamp(int(math.ceil(center_x + radius)), 1, sim.columns - 2)
	min_y := clamp(int(math.floor(center_y - radius)), 1, sim.rows - 2)
	max_y := clamp(int(math.ceil(center_y + radius)), 1, sim.rows - 2)
	color := palette_color(palette, input.hue)
	force := clamp(input.force, 0.05, 1.0)
	drag_x := input.dx * force * 52.0
	drag_y := -input.dy * force * 52.0

	for y in min_y ..= max_y {
		for x in min_x ..= max_x {
			offset_x := f32(x) - center_x
			offset_y := f32(y) - center_y
			distance := math.sqrt(offset_x * offset_x + offset_y * offset_y)
			if distance > radius {
				continue
			}
			falloff := 1.0 - distance / radius
			falloff *= falloff
			i := grid_index(x, y)

			switch input.tool {
			case .Ink:
				dye := 0.5 + force * 1.7
				sim.dye_r[i] = min(sim.dye_r[i] + color[0] * dye * falloff, 8.0)
				sim.dye_g[i] = min(sim.dye_g[i] + color[1] * dye * falloff, 8.0)
				sim.dye_b[i] = min(sim.dye_b[i] + color[2] * dye * falloff, 8.0)
				sim.u[i] = clamp(sim.u[i] + drag_x * falloff, -3.0, 3.0)
				sim.v[i] = clamp(sim.v[i] + drag_y * falloff, -3.0, 3.0)
			case .Vortex:
				inv_distance := 1.0 / max(distance, 0.7)
				spin := (0.7 + force * 2.2) * falloff
				sim.u[i] = clamp(sim.u[i] - offset_y * inv_distance * spin + drag_x * falloff * 0.25, -3.0, 3.0)
				sim.v[i] = clamp(sim.v[i] + offset_x * inv_distance * spin + drag_y * falloff * 0.25, -3.0, 3.0)
				sim.dye_r[i] = min(sim.dye_r[i] + color[0] * falloff * 0.8, 8.0)
				sim.dye_g[i] = min(sim.dye_g[i] + color[1] * falloff * 0.8, 8.0)
				sim.dye_b[i] = min(sim.dye_b[i] + color[2] * falloff * 0.8, 8.0)
			case .Heat:
				sim.dye_r[i] = min(sim.dye_r[i] + (1.0 + color[0] * 0.3) * falloff, 8.0)
				sim.dye_g[i] = min(sim.dye_g[i] + (0.10 + color[1] * 0.25) * falloff, 8.0)
				sim.dye_b[i] = min(sim.dye_b[i] + color[2] * 0.12 * falloff, 8.0)
				sim.v[i] = clamp(sim.v[i] + (0.55 + force * 1.8) * falloff, -3.0, 3.0)
				sim.u[i] = clamp(sim.u[i] + drag_x * falloff * 0.2, -3.0, 3.0)
			case .Erase:
				keep := 1.0 - falloff * 0.92
				sim.dye_r[i] *= keep
				sim.dye_g[i] *= keep
				sim.dye_b[i] *= keep
				sim.u[i] *= keep
				sim.v[i] *= keep
			}
		}
	}
}

apply_input :: proc(sim: ^Sim, input: Fluid_Input, palette: u32) {
	distance_x := input.dx * f32(sim.columns)
	distance_y := input.dy * f32(sim.rows)
	steps := clamp(int(math.ceil(math.sqrt(distance_x * distance_x + distance_y * distance_y))), 1, 32)
	start_x := input.x - input.dx
	start_y := input.y - input.dy
	for step in 1 ..= steps {
		t := f32(step) / f32(steps)
		apply_brush_point(sim, input, palette, start_x + input.dx * t, start_y + input.dy * t)
	}
}

seed_sim :: proc(sim: ^Sim, palette: u32) {
	seeds := [4]Fluid_Input{
		{x = 0.34, y = 0.74, dx = 0.012, dy = -0.018, tool = .Ink, hue = 0.10, radius = 7, force = 0.42},
		{x = 0.48, y = 0.68, dx = -0.015, dy = -0.012, tool = .Vortex, hue = 0.48, radius = 10, force = 0.46},
		{x = 0.61, y = 0.78, dx = 0.008, dy = -0.024, tool = .Heat, hue = 0.82, radius = 8, force = 0.38},
		{x = 0.70, y = 0.63, dx = -0.014, dy = 0.008, tool = .Ink, hue = 0.66, radius = 6, force = 0.34},
	}
	for input in seeds {
		apply_input(sim, input, palette)
	}
}

sim_reset :: proc(sim: ^Sim, palette: u32) {
	sim_clear(sim)
	if sim.columns > 0 && sim.rows > 0 {
		seed_sim(sim, palette)
	}
}

configure_grid :: proc(sim: ^Sim, aspect: f32, palette: u32) {
	columns, rows := 96, 72
	if aspect >= 1.0 {
		rows = 72
		columns = clamp(int(math.round(f32(rows) * aspect)), 72, MAX_GRID_COLUMNS)
	} else {
		columns = 72
		rows = clamp(int(math.round(f32(columns) / max(aspect, 0.3))), 72, MAX_GRID_ROWS)
	}
	if sim.columns != columns || sim.rows != rows {
		sim.columns = columns
		sim.rows = rows
		sim_reset(sim, palette)
	}
}

ambient_emit :: proc(sim: ^Sim, config: Fluid_Config) {
	phase := sim.clock * 0.16
	input := Fluid_Input {
		x = 0.5 + math.sin(phase * 1.7) * 0.12,
		y = 0.92,
		dx = math.cos(phase * 1.3) * 0.0008,
		dy = -0.0025,
		tool = .Ink,
		hue = config.hue + math.sin(phase) * 0.09,
		radius = 3.5,
		force = 0.13,
	}
	apply_input(sim, input, config.palette)
}

sim_step :: proc(sim: ^Sim, config: Fluid_Config, inputs: []Fluid_Input, dt: f32) {
	sim.clock += dt
	for input in inputs {
		apply_input(sim, input, config.palette)
	}
	ambient_emit(sim, config)

	viscosity := 0.000002 + config.viscosity * config.viscosity * 0.00018
	diffuse(sim.u_prev[:], sim.u[:], viscosity, dt, sim.columns, sim.rows, 1)
	diffuse(sim.v_prev[:], sim.v[:], viscosity, dt, sim.columns, sim.rows, 2)
	project_velocity(sim.u_prev[:], sim.v_prev[:], sim.pressure[:], sim.divergence[:], sim.columns, sim.rows)
	advect(sim.u[:], sim.u_prev[:], sim.u_prev[:], sim.v_prev[:], dt, sim.columns, sim.rows, 1)
	advect(sim.v[:], sim.v_prev[:], sim.u_prev[:], sim.v_prev[:], dt, sim.columns, sim.rows, 2)
	apply_vorticity(sim, config.swirl, dt)

	for y in 1 ..< sim.rows - 1 {
		for x in 1 ..< sim.columns - 1 {
			i := grid_index(x, y)
			heat := sim.dye_r[i] - sim.dye_b[i] * 0.28
			sim.v[i] += heat * 0.018 * dt
		}
	}
	project_velocity(sim.u[:], sim.v[:], sim.pressure[:], sim.divergence[:], sim.columns, sim.rows)

	advect(sim.dye_r_prev[:], sim.dye_r[:], sim.u[:], sim.v[:], dt, sim.columns, sim.rows, 0)
	advect(sim.dye_g_prev[:], sim.dye_g[:], sim.u[:], sim.v[:], dt, sim.columns, sim.rows, 0)
	advect(sim.dye_b_prev[:], sim.dye_b[:], sim.u[:], sim.v[:], dt, sim.columns, sim.rows, 0)
	dissipation := math.exp(-(0.10 + config.fade * 1.15) * dt)
	velocity_drag := math.exp(-0.12 * dt)
	for y in 1 ..< sim.rows - 1 {
		for x in 1 ..< sim.columns - 1 {
			i := grid_index(x, y)
			sim.dye_r[i] = sim.dye_r_prev[i] * dissipation
			sim.dye_g[i] = sim.dye_g_prev[i] * dissipation
			sim.dye_b[i] = sim.dye_b_prev[i] * dissipation
			sim.u[i] *= velocity_drag
			sim.v[i] *= velocity_drag
		}
	}
}

FLOATS_PER_INSTANCE :: 8
INSTANCE_STRIDE :: FLOATS_PER_INSTANCE * size_of(f32)

pack_instances :: proc(sim: ^Sim, out: []f32) -> (count, active: int) {
	half_width := 1.08 / f32(sim.columns - 2)
	half_height := 1.08 / f32(sim.rows - 2)
	for y in 1 ..< sim.rows - 1 {
		for x in 1 ..< sim.columns - 1 {
			i := grid_index(x, y)
			energy := max(sim.dye_r[i], max(sim.dye_g[i], sim.dye_b[i]))
			if energy < 0.002 {
				continue
			}
			base := count * FLOATS_PER_INSTANCE
			out[base + 0] = (f32(x) - 0.5) / f32(sim.columns - 2) * 2.0 - 1.0
			out[base + 1] = (f32(y) - 0.5) / f32(sim.rows - 2) * 2.0 - 1.0
			out[base + 2] = half_width
			out[base + 3] = half_height
			out[base + 4] = 1.0 - math.exp(-sim.dye_r[i] * 1.45)
			out[base + 5] = 1.0 - math.exp(-sim.dye_g[i] * 1.45)
			out[base + 6] = 1.0 - math.exp(-sim.dye_b[i] * 1.45)
			out[base + 7] = clamp(energy * 0.72, 0.02, 1.0)
			count += 1
			if energy > 0.03 {
				active += 1
			}
		}
	}
	return
}

// ---------------------------------------------------------------------------
// WGSL shader: soft luminous fluid cells with additive edge blending
// ---------------------------------------------------------------------------

FLUID_SHADER: string : `
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
  let edge = max(abs(local.x), abs(local.y));
  let body = 1.0 - smoothstep(0.72, 1.0, edge);
  let bloom = exp(-dot(local, local) * 1.45) * 0.22;
  let intensity = (body + bloom) * color.a;
  return vec4<f32>(color.rgb * intensity, intensity);
}
`

// ---------------------------------------------------------------------------
// Dawn webgpu C ABI: enum values and struct layouts
// (identical to the byte layouts templates/zig-wgpu builds by hand)
// ---------------------------------------------------------------------------

DEFAULT_SURFACE_FORMAT :: u32(0x0000001b) // BGRA8Unorm
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

Wgpu_Surface_Capabilities :: struct {
	next_in_chain:     rawptr,
	usages:            u64,
	format_count:      uintptr,
	formats:           [^]u32,
	present_mode_count: uintptr,
	present_modes:     [^]u32,
	alpha_mode_count:  uintptr,
	alpha_modes:       [^]u32,
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
#assert(size_of(Wgpu_Surface_Capabilities) == 64)
#assert(offset_of(Wgpu_Surface_Capabilities, formats) == 24)
#assert(offset_of(Wgpu_Surface_Capabilities, alpha_modes) == 56)
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
Surface_Get_Capabilities_Fn :: proc "c" (rawptr, rawptr, ^Wgpu_Surface_Capabilities) -> u32
Surface_Capabilities_Free_Members_Fn :: proc "c" (Wgpu_Surface_Capabilities)

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
	surface_get_capabilities:         Surface_Get_Capabilities_Fn,
	surface_capabilities_free_members: Surface_Capabilities_Free_Members_Fn,
}

wgpu_symbol :: proc(lib: dynlib.Library, name: string) -> (rawptr, bool) {
	ptr, found := dynlib.symbol_address(lib, name)
	if !found {
		fmt.eprintf("[odin-fluid] missing wgpu symbol: %s\n", name)
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
	p = wgpu_symbol(lib, "wgpuSurfaceGetCapabilities") or_return
	api.surface_get_capabilities = cast(Surface_Get_Capabilities_Fn)p
	p = wgpu_symbol(lib, "wgpuSurfaceCapabilitiesFreeMembers") or_return
	api.surface_capabilities_free_members = cast(Surface_Capabilities_Free_Members_Fn)p

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
	config:          Fluid_Config,
	inputs:          [MAX_INPUTS]Fluid_Input,
	input_count:     int,
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
g_shutting_down: bool

// Stop the worker threads as soon as the window goes away. The core destroys a
// window's webviews and WGPU views before it reports the close, so anything the
// render loop sends afterwards targets ids that no longer exist and the core
// answers with "Webview <id> not found". The SDK quits the app once the last
// window closes; this just makes sure we stop talking to dead views first.
request_shutdown :: proc() {
	if intrinsics.atomic_exchange(&g_shutting_down, true) {
		return
	}

	if g_state != nil {
		sync.mutex_lock(&g_state.gpu.mutex)
		g_state.gpu.running = false
		g_state.gpu.view_id = 0
		g_state.gpu.host_webview_id = 0
		sync.mutex_unlock(&g_state.gpu.mutex)
	}

	intrinsics.atomic_store(&g_queue_running, false)
}

main_window_closed :: proc "c" (_: u32) {
	context = runtime.default_context()
	request_shutdown()
}
g_logged_pointer_input: bool
g_logged_frame_stats: bool

app_state :: proc() -> ^App_State {
	if g_state == nil {
		panic("odin-fluid state not initialized")
	}
	return g_state
}

// ---------------------------------------------------------------------------
// Pipeline creation and per-frame rendering
// ---------------------------------------------------------------------------

CORNER_VERTEX_COUNT :: 6
CORNER_STRIDE :: 2 * size_of(f32)
CORNER_BUFFER_SIZE :: CORNER_VERTEX_COUNT * CORNER_STRIDE
INSTANCE_BUFFER_SIZE :: MAX_CELLS * INSTANCE_STRIDE

Gpu_Pipeline :: struct {
	pipeline:        rawptr,
	corner_buffer:   rawptr,
	instance_buffer: rawptr,
}

create_fluid_pipeline :: proc(
	api: Wgpu_Api,
	ctx: electrobun.WgpuContext,
	queue: rawptr,
	surface_format: u32,
) -> (
	pipeline: Gpu_Pipeline,
	ok: bool,
) {
	shader_code := FLUID_SHADER
	shader_source := Wgpu_Shader_Source_WGSL {
		s_type = STYPE_SHADER_SOURCE_WGSL,
		code   = string_view(shader_code),
	}
	shader_descriptor := Wgpu_Shader_Module_Descriptor {
		next_in_chain = &shader_source,
	}
	shader_module := api.device_create_shader_module(ctx.device_ptr, &shader_descriptor)
	if shader_module == nil {
		fmt.eprintln("[odin-fluid] failed to create shader module")
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

	// Neighboring fluid cells overlap slightly and add a restrained neon halo.
	blend := Wgpu_Blend_State {
		color = {operation = BLEND_OPERATION_ADD, src_factor = BLEND_FACTOR_ONE, dst_factor = BLEND_FACTOR_ONE},
		alpha = {operation = BLEND_OPERATION_ADD, src_factor = BLEND_FACTOR_ONE, dst_factor = BLEND_FACTOR_ONE},
	}
	color_target := Wgpu_Color_Target_State {
		format     = surface_format,
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
		fmt.eprintln("[odin-fluid] failed to create render pipeline")
		return {}, false
	}

	corner_descriptor := Wgpu_Buffer_Descriptor {
		usage = BUFFER_USAGE_VERTEX | BUFFER_USAGE_COPY_DST,
		size  = CORNER_BUFFER_SIZE,
	}
	pipeline.corner_buffer = api.device_create_buffer(ctx.device_ptr, &corner_descriptor)
	if pipeline.corner_buffer == nil {
		fmt.eprintln("[odin-fluid] failed to create corner buffer")
		return {}, false
	}

	instance_descriptor := Wgpu_Buffer_Descriptor {
		usage = BUFFER_USAGE_VERTEX | BUFFER_USAGE_COPY_DST,
		size  = INSTANCE_BUFFER_SIZE,
	}
	pipeline.instance_buffer = api.device_create_buffer(ctx.device_ptr, &instance_descriptor)
	if pipeline.instance_buffer == nil {
		fmt.eprintln("[odin-fluid] failed to create instance buffer")
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

pick_surface_configuration :: proc(
	api: Wgpu_Api,
	ctx: electrobun.WgpuContext,
) -> (
	format: u32,
	alpha_mode: u32,
	ok: bool,
) {
	format = DEFAULT_SURFACE_FORMAT
	alpha_mode = COMPOSITE_ALPHA_MODE_OPAQUE
	capabilities: Wgpu_Surface_Capabilities
	status := api.surface_get_capabilities(
		ctx.surface_ptr,
		ctx.adapter_ptr,
		&capabilities,
	)
	defer api.surface_capabilities_free_members(capabilities)
	if status != 1 || capabilities.format_count == 0 || capabilities.formats == nil {
		return
	}
	format = capabilities.formats[0]
	if capabilities.alpha_mode_count > 0 && capabilities.alpha_modes != nil {
		alpha_mode = capabilities.alpha_modes[0]
	}
	ok = true
	return
}

configure_surface :: proc(
	core: ^electrobun.Core,
	ctx: electrobun.WgpuContext,
	width: u32,
	height: u32,
	surface_format: u32,
	alpha_mode: u32,
) -> electrobun.Error {
	config := Wgpu_Surface_Configuration {
		device       = ctx.device_ptr,
		format       = surface_format,
		usage        = TEXTURE_USAGE_RENDER_ATTACHMENT,
		width        = width,
		height       = height,
		alpha_mode   = alpha_mode,
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

send_fluid_frame :: proc(
	webview_id, view_id: u32,
	frame: u64,
	fps: f64,
	columns, rows, active: int,
	width, height: u32,
) {
	state := app_state()
	_ = electrobun.sendHostMessageToWebview(
		state.core,
		webview_id,
		struct {
			type:    string,
			id:      string,
			payload: struct {
				id:      u32,
				frame:   u64,
				fps:     f64,
				columns: int,
				rows:    int,
				active:  int,
				width:   u32,
				height:  u32,
			},
		}{
			type = "message",
			id = "fluidFrame",
			payload = {
				id = view_id,
				frame = frame,
				fps = fps,
				columns = columns,
				rows = rows,
				active = active,
				width = width,
				height = height,
			},
		},
	)
}

gpu_render_loop :: proc() {
	state := app_state()

	native, native_err := electrobun.wgpuNativeLoad()
	if native_err != .None {
		fmt.eprintfln("[odin-fluid] failed to load WGPU library: %v", native_err)
		return
	}
	defer electrobun.close(&native)

	api, api_ok := wgpu_api_load(&native)
	if !api_ok {
		return
	}

	sim := new(Sim)
	defer free(sim)

	instance_data := make([]f32, MAX_CELLS * FLOATS_PER_INSTANCE)
	defer delete(instance_data)
	local_inputs: [MAX_INPUTS]Fluid_Input

	active_view_id: u32
	ctx: electrobun.WgpuContext
	has_context := false
	pipeline: Gpu_Pipeline
	queue: rawptr
	configured_width: u32
	configured_height: u32
	frame: u64
	surface_format := DEFAULT_SURFACE_FORMAT
	alpha_mode := COMPOSITE_ALPHA_MODE_OPAQUE
	logged_first_frame := false
	fps_tick := time.tick_now()
	frames_since_report := 0
	measured_fps: f64

	DT :: f32(1.0 / 60.0)

	for intrinsics.atomic_load(&g_queue_running) {
		loop_tick := time.tick_now()
		sync.mutex_lock(&state.gpu.mutex)
		running := state.gpu.running
		view_id := state.gpu.view_id
		host_webview_id := state.gpu.host_webview_id
		width := state.gpu.width
		height := state.gpu.height
		config := state.gpu.config
		reset_requested := state.gpu.reset_requested
		state.gpu.reset_requested = false
		input_count := state.gpu.input_count
		for i in 0 ..< input_count {
			local_inputs[i] = state.gpu.inputs[i]
		}
		state.gpu.input_count = 0
		sync.mutex_unlock(&state.gpu.mutex)
		if input_count > 0 && !g_logged_pointer_input {
			g_logged_pointer_input = true
			fmt.println("[odin-fluid] pointer input connected")
		}

		if !running || view_id == 0 {
			time.sleep(16 * time.Millisecond)
			continue
		}

		if !has_context || active_view_id != view_id {
			new_ctx, ctx_err := electrobun.createForWgpuView(state.core, &native, view_id)
			if ctx_err != .None {
				fmt.eprintfln("[odin-fluid] failed to create WGPU context: %v", ctx_err)
				time.sleep(250 * time.Millisecond)
				continue
			}
			ctx = new_ctx
			queue = electrobun.getQueue(ctx, &native)
			if queue == nil {
				fmt.eprintln("[odin-fluid] failed to get WGPU queue")
				time.sleep(250 * time.Millisecond)
				continue
			}
			selected_format, selected_alpha_mode, capabilities_ok :=
				pick_surface_configuration(api, ctx)
			if !capabilities_ok {
				fmt.eprintln("[odin-fluid] failed to read surface capabilities")
				time.sleep(250 * time.Millisecond)
				continue
			}
			new_pipeline, pipeline_ok := create_fluid_pipeline(
				api,
				ctx,
				queue,
				selected_format,
			)
			if !pipeline_ok {
				time.sleep(250 * time.Millisecond)
				continue
			}
			pipeline = new_pipeline
			surface_format = selected_format
			alpha_mode = selected_alpha_mode
			has_context = true
			active_view_id = view_id
			configured_width = 0
			configured_height = 0
			logged_first_frame = false
			fmt.printfln(
				"[odin-fluid] WGPU context ready for view %d (format=%d alpha=%d)",
				view_id,
				surface_format,
				alpha_mode,
			)
		}

		if configured_width != width || configured_height != height {
			if configure_surface(
				state.core,
				ctx,
				width,
				height,
				surface_format,
				alpha_mode,
			) != .None {
				fmt.eprintln("[odin-fluid] failed to configure surface")
				time.sleep(250 * time.Millisecond)
				continue
			}
			configured_width = width
			configured_height = height
		}

		aspect := f32(width) / max(f32(height), 1)
		configure_grid(sim, aspect, config.palette)
		if reset_requested {
			sim_reset(sim, config.palette)
		}

		if !config.paused {
			sim_step(sim, config, local_inputs[:input_count], DT)
		}
		instance_count, active_cells := pack_instances(sim, instance_data)

		if !render_frame(state.core, api, ctx, pipeline, queue, instance_data, instance_count) {
			time.sleep(100 * time.Millisecond)
			continue
		}
		if !logged_first_frame {
			logged_first_frame = true
			fmt.printfln(
				"[odin-fluid] first frame submitted (%d fluid cells)",
				instance_count,
			)
		}

		frame += 1
		frames_since_report += 1
		if frames_since_report >= 30 {
			elapsed := time.duration_seconds(time.tick_since(fps_tick))
			if elapsed > 0 {
				measured_fps = f64(frames_since_report) / elapsed
			}
			fps_tick = time.tick_now()
			frames_since_report = 0
			if !g_logged_frame_stats {
				g_logged_frame_stats = true
				fmt.printfln(
					"[odin-fluid] solver stable at %.1f fps (%d x %d grid, %d active cells)",
					measured_fps,
					sim.columns,
					sim.rows,
					active_cells,
				)
			}
			if host_webview_id != 0 {
				send_fluid_frame(
					host_webview_id,
					view_id,
					frame,
					measured_fps,
					sim.columns,
					sim.rows,
					active_cells,
					width,
					height,
				)
			}
		}

		frame_time := time.tick_since(loop_tick)
		if frame_time < 16 * time.Millisecond {
			time.sleep(16 * time.Millisecond - frame_time)
		}
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
		fmt.eprintfln("[odin-fluid] failed to send response: %v", err)
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
		fmt.eprintfln("[odin-fluid] failed to send error response: %v", err)
	}
}

configure_fluid_from_params :: proc(state: ^App_State, webview_id: u32, params: json.Object) -> bool {
	view_id := obj_u32(params, "id", 0)
	if view_id == 0 {
		return false
	}
	config_value, config_found := params["config"]
	if !config_found {
		return false
	}
	config, config_is_object := config_value.(json.Object)
	if !config_is_object {
		return false
	}

	sync.mutex_lock(&state.gpu.mutex)
	defer sync.mutex_unlock(&state.gpu.mutex)
	state.gpu.view_id = view_id
	state.gpu.host_webview_id = webview_id
	state.gpu.width = rect_dimension(params, "width", state.gpu.width)
	state.gpu.height = rect_dimension(params, "height", state.gpu.height)
	state.gpu.config.palette = min(obj_u32(config, "palette", state.gpu.config.palette), 3)
	state.gpu.config.hue = clamp(f32(obj_f64(config, "hue", f64(state.gpu.config.hue) * 100)) / 100, 0, 1)
	state.gpu.config.radius = clamp(f32(obj_f64(config, "radius", f64(state.gpu.config.radius))), 2, 20)
	state.gpu.config.force = clamp(f32(obj_f64(config, "force", f64(state.gpu.config.force) * 100)) / 100, 0.05, 1)
	state.gpu.config.swirl = clamp(f32(obj_f64(config, "swirl", f64(state.gpu.config.swirl) * 100)) / 100, 0, 1)
	state.gpu.config.viscosity = clamp(f32(obj_f64(config, "viscosity", f64(state.gpu.config.viscosity) * 100)) / 100, 0, 1)
	state.gpu.config.fade = clamp(f32(obj_f64(config, "fade", f64(state.gpu.config.fade) * 100)) / 100, 0, 1)
	state.gpu.config.paused = obj_bool(config, "paused", state.gpu.config.paused)
	return true
}

enqueue_fluid_input :: proc(state: ^App_State, params: json.Object) -> bool {
	x := f32(obj_f64(params, "x", -1))
	y := f32(obj_f64(params, "y", -1))
	if x < 0 || x > 1 || y < 0 || y > 1 {
		return false
	}
	input := Fluid_Input {
		x = x,
		y = y,
		dx = clamp(f32(obj_f64(params, "dx", 0)), -1, 1),
		dy = clamp(f32(obj_f64(params, "dy", 0)), -1, 1),
		tool = Fluid_Tool(min(obj_u32(params, "tool", 0), 3)),
		hue = clamp(f32(obj_f64(params, "hue", 50)) / 100, 0, 1),
		radius = clamp(f32(obj_f64(params, "radius", 8)), 2, 20),
		force = clamp(f32(obj_f64(params, "force", 60)) / 100, 0.05, 1),
	}

	sync.mutex_lock(&state.gpu.mutex)
	defer sync.mutex_unlock(&state.gpu.mutex)
	if state.gpu.input_count < MAX_INPUTS {
		state.gpu.inputs[state.gpu.input_count] = input
		state.gpu.input_count += 1
	} else {
		// Keep the newest pointer location when input briefly outruns rendering.
		state.gpu.inputs[MAX_INPUTS - 1] = input
	}
	return true
}

handle_rpc_request :: proc(webview_id: u32, request_id: u64, method: string, params: json.Value) {
	state := app_state()

	params_obj, params_is_object := params.(json.Object)

	switch method {
	case "startFluid":
		if !params_is_object || !configure_fluid_from_params(state, webview_id, params_obj) {
			send_rpc_error(webview_id, request_id, "InvalidParams")
			return
		}
		sync.mutex_lock(&state.gpu.mutex)
		state.gpu.running = true
		started_view_id := state.gpu.view_id
		sync.mutex_unlock(&state.gpu.mutex)
		fmt.printfln("[odin-fluid] starting WGPU view %d", started_view_id)
		ensure_gpu_thread()
		send_rpc_success(webview_id, request_id)

	case "configureFluid":
		if !params_is_object || !configure_fluid_from_params(state, webview_id, params_obj) {
			send_rpc_error(webview_id, request_id, "InvalidParams")
			return
		}
		send_rpc_success(webview_id, request_id)

	case "injectFluid":
		if !params_is_object || !enqueue_fluid_input(state, params_obj) {
			send_rpc_error(webview_id, request_id, "InvalidParams")
			return
		}
		send_rpc_success(webview_id, request_id)

	case "resetFluid":
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
		fmt.eprintfln("[odin-fluid] failed to parse RPC packet: %v", parse_err)
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
		fmt.eprintfln("[odin-fluid] failed to configure webview runtime: %v", err)
		return
	}

	window_options := electrobun.defaultWindowOptions("Neon Fluid Lab")
	window_options.frame = {x = 120, y = 80, width = 1180, height = 760}
	window_options.callbacks = {close = main_window_closed}
	window_id, window_err := electrobun.createWindow(state.core, window_options)
	if window_err != .None {
		fmt.eprintfln("[odin-fluid] failed to create window: %v", window_err)
		return
	}

	webview_options := electrobun.defaultWebviewOptions(window_id)
	webview_options.url = "views://mainview/index.html"
	webview_options.frame = {x = 0, y = 0, width = 1180, height = 760}
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
		fmt.eprintfln("[odin-fluid] failed to create webview: %v", webview_err)
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
		fmt.eprintfln("[odin-fluid] failed to load Electrobun core: %v", core_err)
		return
	}
	defer electrobun.close(&core)

	bundle_paths, bundle_err := electrobun.resolveBundlePaths()
	if bundle_err != .None {
		fmt.eprintfln("[odin-fluid] failed to resolve bundle paths: %v", bundle_err)
		return
	}
	defer electrobun.deinit(&bundle_paths, context.allocator)

	owned_app_info, app_info_err := electrobun.resolveAppInfoFromBundle(context.allocator, &bundle_paths)
	if app_info_err != .None {
		fmt.eprintfln("[odin-fluid] failed to resolve app info: %v", app_info_err)
		return
	}
	defer electrobun.deinit(&owned_app_info, context.allocator)
	app_info := electrobun.borrowed(owned_app_info)

	state := App_State {
		core         = &core,
		bundle_paths = &bundle_paths,
	}
	state.gpu.config = default_fluid_config()
	state.gpu.width = 640
	state.gpu.height = 420

	g_state = &state
	defer g_state = nil

	intrinsics.atomic_store(&g_queue_running, true)
	thread.create_and_start(create_ui, self_cleanup = true)
	thread.create_and_start(drain_host_message_queue, self_cleanup = true)

	defer request_shutdown()

	if err := electrobun.runMainThread(&core, app_info); err != .None {
		fmt.eprintfln("[odin-fluid] main thread exited with error: %v", err)
	}
}
