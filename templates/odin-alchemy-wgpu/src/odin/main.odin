// Odin Alchemy Sandbox: a deterministic cellular-material simulation owned by
// an Odin main process and rendered on a native <electrobun-wgpu> surface.
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

GRID_WIDTH :: 320
GRID_HEIGHT :: 180
CELL_COUNT :: GRID_WIDTH * GRID_HEIGHT
DEFAULT_SEED :: u32(0x10203040)
PLANT_ROOTED_AGE :: u16(1000)

Material :: enum u8 {
	Empty = 0,
	Sand  = 1,
	Water = 2,
	Fire  = 3,
	Plant = 4,
	Oil   = 5,
	Stone = 6,
}

Cell :: struct {
	material: Material,
	age:      u16,
	shade:    u8,
}

Sim :: struct {
	cells:    [CELL_COUNT]Cell,
	updated:  [CELL_COUNT]u32,
	tick:     u32,
	rng:      u32,
	occupied: int,
}

cell_index :: proc(x, y: int) -> int {
	return y * GRID_WIDTH + x
}

in_bounds :: proc(x, y: int) -> bool {
	return x >= 0 && x < GRID_WIDTH && y >= 0 && y < GRID_HEIGHT
}

rand_u32 :: proc(state: ^u32) -> u32 {
	x := state^
	if x == 0 {
		x = 0x6D2B79F5
	}
	x ~= x << 13
	x ~= x >> 17
	x ~= x << 5
	state^ = x
	return x
}

set_cell :: proc(sim: ^Sim, x, y: int, material: Material) {
	if !in_bounds(x, y) {
		return
	}
	index := cell_index(x, y)
	was_empty := sim.cells[index].material == .Empty
	will_be_empty := material == .Empty
	if was_empty && !will_be_empty {
		sim.occupied += 1
	} else if !was_empty && will_be_empty {
		sim.occupied -= 1
	}
	if will_be_empty {
		sim.cells[index] = {}
	} else {
		sim.cells[index] = {
			material = material,
			shade = u8(rand_u32(&sim.rng) & 0xff),
		}
	}
}

move_cell :: proc(sim: ^Sim, from_x, from_y, to_x, to_y: int) {
	from_index := cell_index(from_x, from_y)
	to_index := cell_index(to_x, to_y)
	sim.cells[to_index] = sim.cells[from_index]
	sim.cells[from_index] = {}
	sim.updated[from_index] = sim.tick
	sim.updated[to_index] = sim.tick
}

swap_cells :: proc(sim: ^Sim, ax, ay, bx, by: int) {
	a := cell_index(ax, ay)
	b := cell_index(bx, by)
	temp := sim.cells[a]
	sim.cells[a] = sim.cells[b]
	sim.cells[b] = temp
	sim.updated[a] = sim.tick
	sim.updated[b] = sim.tick
}

material_at :: proc(sim: ^Sim, x, y: int) -> Material {
	if !in_bounds(x, y) {
		return .Stone
	}
	return sim.cells[cell_index(x, y)].material
}

has_adjacent :: proc(sim: ^Sim, x, y: int, material: Material) -> bool {
	return material_at(sim, x - 1, y) == material ||
	       material_at(sim, x + 1, y) == material ||
	       material_at(sim, x, y - 1) == material ||
	       material_at(sim, x, y + 1) == material
}

find_nearby_water :: proc(sim: ^Sim, x, y, radius: int) -> (int, int, bool) {
	dy := -radius
	for dy <= radius {
		dx := -radius
		for dx <= radius {
			if abs(dx) + abs(dy) <= radius && material_at(sim, x + dx, y + dy) == .Water {
				return x + dx, y + dy, true
			}
			dx += 1
		}
		dy += 1
	}
	return 0, 0, false
}

try_diagonal :: proc(sim: ^Sim, x, y: int, material: Material) -> bool {
	direction := 1
	if rand_u32(&sim.rng) & 1 == 0 {
		direction = -1
	}
	for attempt in 0 ..< 2 {
		dx := direction
		if attempt == 1 {
			dx = -direction
		}
		target := material_at(sim, x + dx, y + 1)
		if target == .Empty {
			move_cell(sim, x, y, x + dx, y + 1)
			return true
		}
		if material == .Sand && (target == .Water || target == .Oil || target == .Fire) {
			swap_cells(sim, x, y, x + dx, y + 1)
			return true
		}
		if material == .Water && target == .Oil {
			swap_cells(sim, x, y, x + dx, y + 1)
			return true
		}
	}
	return false
}

try_sideways :: proc(sim: ^Sim, x, y, distance: int) -> bool {
	direction := 1
	if rand_u32(&sim.rng) & 1 == 0 {
		direction = -1
	}
	for attempt in 0 ..< 2 {
		dx := direction
		if attempt == 1 {
			dx = -direction
		}
		target_x := x
		for step in 1 ..= distance {
			next_x := x + dx * step
			if material_at(sim, next_x, y) != .Empty {
				break
			}
			target_x = next_x
		}
		if target_x != x {
			move_cell(sim, x, y, target_x, y)
			return true
		}
	}
	return false
}

process_sand :: proc(sim: ^Sim, x, y: int) {
	if y + 1 >= GRID_HEIGHT {
		return
	}
	below := material_at(sim, x, y + 1)
	if below == .Empty {
		move_cell(sim, x, y, x, y + 1)
		return
	}
	if below == .Water || below == .Oil || below == .Fire {
		swap_cells(sim, x, y, x, y + 1)
		return
	}
	_ = try_diagonal(sim, x, y, .Sand)
}

process_water :: proc(sim: ^Sim, x, y: int) {
	if y + 1 < GRID_HEIGHT {
		below := material_at(sim, x, y + 1)
		if below == .Empty {
			move_cell(sim, x, y, x, y + 1)
			return
		}
		if below == .Oil {
			swap_cells(sim, x, y, x, y + 1)
			return
		}
	}
	if try_diagonal(sim, x, y, .Water) {
		return
	}
	_ = try_sideways(sim, x, y, 3)
}

ignite_cell :: proc(sim: ^Sim, x, y: int) {
	if !in_bounds(x, y) {
		return
	}
	index := cell_index(x, y)
	material := sim.cells[index].material
	if material != .Oil && material != .Plant {
		return
	}
	sim.cells[index].material = .Fire
	sim.cells[index].age = 0
	sim.cells[index].shade = u8(rand_u32(&sim.rng) & 0x3f)
	sim.updated[index] = sim.tick
}

ignite_neighbors :: proc(sim: ^Sim, x, y: int) {
	if rand_u32(&sim.rng) % 3 == 0 {
		ignite_cell(sim, x - 1, y)
	}
	if rand_u32(&sim.rng) % 3 == 0 {
		ignite_cell(sim, x + 1, y)
	}
	if rand_u32(&sim.rng) % 3 == 0 {
		ignite_cell(sim, x, y - 1)
	}
	if rand_u32(&sim.rng) % 3 == 0 {
		ignite_cell(sim, x, y + 1)
	}
}

process_oil :: proc(sim: ^Sim, x, y: int) {
	if has_adjacent(sim, x, y, .Fire) && rand_u32(&sim.rng) % 2 == 0 {
		ignite_cell(sim, x, y)
		return
	}
	if y + 1 < GRID_HEIGHT && material_at(sim, x, y + 1) == .Empty {
		move_cell(sim, x, y, x, y + 1)
		return
	}
	if try_diagonal(sim, x, y, .Oil) {
		return
	}
	_ = try_sideways(sim, x, y, 2)
}

process_plant :: proc(sim: ^Sim, x, y: int) {
	index := cell_index(x, y)
	if has_adjacent(sim, x, y, .Fire) {
		if rand_u32(&sim.rng) % 3 == 0 {
			ignite_cell(sim, x, y)
		}
		return
	}

	if sim.cells[index].age < PLANT_ROOTED_AGE {
		if y + 1 < GRID_HEIGHT {
			below := material_at(sim, x, y + 1)
			if below == .Empty {
				move_cell(sim, x, y, x, y + 1)
				return
			}
			if below == .Water {
				swap_cells(sim, x, y, x, y + 1)
				return
			}
		}
		water_x, water_y, found_water := find_nearby_water(sim, x, y, 5)
		if found_water {
			set_cell(sim, water_x, water_y, .Empty)
			sim.cells[index].age = PLANT_ROOTED_AGE
		}
		return
	}

	if sim.tick % 7 != 0 || rand_u32(&sim.rng) % 4 != 0 {
		return
	}
	water_x, water_y, found_water := find_nearby_water(sim, x, y, 6)
	if !found_water {
		return
	}

	direction := 0
	choice := rand_u32(&sim.rng) % 5
	if choice == 0 {
		direction = -1
	} else if choice == 1 {
		direction = 1
	}
	target_x := x + direction
	target_y := y - 1
	if material_at(sim, target_x, target_y) != .Empty {
		return
	}
	set_cell(sim, water_x, water_y, .Empty)
	set_cell(sim, target_x, target_y, .Plant)
	target_index := cell_index(target_x, target_y)
	sim.cells[target_index].age = PLANT_ROOTED_AGE + 1
	sim.updated[target_index] = sim.tick
}

process_fire :: proc(sim: ^Sim, x, y: int) {
	index := cell_index(x, y)
	if has_adjacent(sim, x, y, .Water) {
		set_cell(sim, x, y, .Empty)
		return
	}

	ignite_neighbors(sim, x, y)
	sim.cells[index].age += 1
	lifetime := u16(26 + sim.cells[index].shade)
	if sim.cells[index].age > lifetime {
		set_cell(sim, x, y, .Empty)
		return
	}

	if sim.tick & 1 == 0 && y > 0 {
		if material_at(sim, x, y - 1) == .Empty {
			move_cell(sim, x, y, x, y - 1)
			return
		}
		direction := 1
		if rand_u32(&sim.rng) & 1 == 0 {
			direction = -1
		}
		if material_at(sim, x + direction, y - 1) == .Empty {
			move_cell(sim, x, y, x + direction, y - 1)
		}
	}
}

sim_step :: proc(sim: ^Sim) {
	sim.tick += 1
	if sim.tick == 0 {
		for index in 0 ..< CELL_COUNT {
			sim.updated[index] = 0
		}
		sim.tick = 1
	}

	reverse := sim.tick & 1 == 0
	y := GRID_HEIGHT - 2
	for y >= 0 {
		for column in 0 ..< GRID_WIDTH {
			x := column
			if reverse {
				x = GRID_WIDTH - 1 - column
			}
			index := cell_index(x, y)
			if sim.updated[index] == sim.tick {
				continue
			}
			switch sim.cells[index].material {
			case .Sand:
				process_sand(sim, x, y)
			case .Water:
				process_water(sim, x, y)
			case .Oil:
				process_oil(sim, x, y)
			case .Plant:
				process_plant(sim, x, y)
			case .Empty, .Fire, .Stone:
			}
		}
		y -= 1
	}

	for y in 0 ..< GRID_HEIGHT {
		for column in 0 ..< GRID_WIDTH {
			x := column
			if !reverse {
				x = GRID_WIDTH - 1 - column
			}
			index := cell_index(x, y)
			if sim.updated[index] != sim.tick && sim.cells[index].material == .Fire {
				process_fire(sim, x, y)
			}
		}
	}
}

paint_circle :: proc(sim: ^Sim, center_x, center_y, radius: int, material: Material) {
	radius_squared := radius * radius
	for dy in -radius ..= radius {
		for dx in -radius ..= radius {
			if dx * dx + dy * dy > radius_squared {
				continue
			}
			x := center_x + dx
			y := center_y + dy
			if !in_bounds(x, y) {
				continue
			}
			if material != .Empty && rand_u32(&sim.rng) % 100 >= 94 {
				continue
			}
			set_cell(sim, x, y, material)
		}
	}
}

Paint_Command :: struct {
	from_x, from_y: f32,
	to_x, to_y:     f32,
	radius:          int,
	material:        Material,
}

apply_paint_command :: proc(sim: ^Sim, command: Paint_Command) {
	x0 := int(clamp(command.from_x, 0, 1) * f32(GRID_WIDTH - 1))
	y0 := int(clamp(command.from_y, 0, 1) * f32(GRID_HEIGHT - 1))
	x1 := int(clamp(command.to_x, 0, 1) * f32(GRID_WIDTH - 1))
	y1 := int(clamp(command.to_y, 0, 1) * f32(GRID_HEIGHT - 1))
	dx := x1 - x0
	dy := y1 - y0
	steps := max(abs(dx), abs(dy))
	if steps == 0 {
		paint_circle(sim, x0, y0, command.radius, command.material)
		return
	}
	for step in 0 ..= steps {
		t := f32(step) / f32(steps)
		x := int(f32(x0) + f32(dx) * t)
		y := int(f32(y0) + f32(dy) * t)
		paint_circle(sim, x, y, command.radius, command.material)
	}
}

sim_populate_demo :: proc(sim: ^Sim) {
	for y in GRID_HEIGHT - 6 ..< GRID_HEIGHT {
		for x in 0 ..< GRID_WIDTH {
			set_cell(sim, x, y, .Stone)
		}
	}

	for y in GRID_HEIGHT - 44 ..< GRID_HEIGHT - 6 {
		set_cell(sim, 18, y, .Stone)
		set_cell(sim, 112, y, .Stone)
		set_cell(sim, 214, y, .Stone)
		set_cell(sim, 294, y, .Stone)
	}

	for y in GRID_HEIGHT - 34 ..< GRID_HEIGHT - 6 {
		for x in 22 ..< 109 {
			set_cell(sim, x, y, .Water)
		}
	}
	for y in GRID_HEIGHT - 27 ..< GRID_HEIGHT - 6 {
		for x in 218 ..< 291 {
			set_cell(sim, x, y, .Oil)
		}
	}

	for row in 0 ..< 44 {
		width := 3 + row * 2
		start := 162 - width / 2
		for x in start ..< start + width {
			set_cell(sim, x, GRID_HEIGHT - 7 - row, .Sand)
		}
	}

	for x in 31 ..< 101 {
		if x % 11 == 0 {
			set_cell(sim, x, GRID_HEIGHT - 39, .Plant)
		}
	}
	for x in 225 ..< 286 {
		if x % 4 == 0 {
			set_cell(sim, x, GRID_HEIGHT - 28, .Fire)
		}
	}
}

sim_reset :: proc(sim: ^Sim, seed: u32) {
	sim^ = {}
	sim.rng = seed
	if sim.rng == 0 {
		sim.rng = DEFAULT_SEED
	}
	sim_populate_demo(sim)
}

FLOATS_PER_INSTANCE :: 8
INSTANCE_STRIDE :: FLOATS_PER_INSTANCE * size_of(f32)

cell_color :: proc(cell: Cell, tick: u32) -> [4]f32 {
	variation := (f32(cell.shade) / 255.0 - 0.5) * 0.16
	switch cell.material {
	case .Sand:
		return {0.90 + variation, 0.62 + variation * 0.5, 0.18, 1}
	case .Water:
		wave := math.sin(f32(tick) * 0.08 + f32(cell.shade)) * 0.05
		return {0.06, 0.43 + wave, 0.83 + variation, 0.94}
	case .Fire:
		flicker := f32((tick + u32(cell.shade)) % 9) / 9.0
		return {1.0, 0.18 + flicker * 0.48, 0.025, 1}
	case .Plant:
		if cell.age < PLANT_ROOTED_AGE {
			return {0.58, 0.82, 0.20, 1}
		}
		return {0.10 + variation, 0.62 + variation, 0.20, 1}
	case .Oil:
		return {0.32 + variation, 0.16, 0.46 + variation, 1}
	case .Stone:
		return {0.43 + variation, 0.45 + variation, 0.47 + variation, 1}
	case .Empty:
		return {0, 0, 0, 0}
	}
	return {0, 0, 0, 0}
}

pack_instances :: proc(sim: ^Sim, out: []f32) -> int {
	count := 0
	half_width := 1.02 / f32(GRID_WIDTH)
	half_height := 1.02 / f32(GRID_HEIGHT)
	for y in 0 ..< GRID_HEIGHT {
		for x in 0 ..< GRID_WIDTH {
			cell := sim.cells[cell_index(x, y)]
			if cell.material == .Empty {
				continue
			}
			color := cell_color(cell, sim.tick)
			base := count * FLOATS_PER_INSTANCE
			out[base + 0] = (f32(x) + 0.5) / f32(GRID_WIDTH) * 2.0 - 1.0
			out[base + 1] = 1.0 - (f32(y) + 0.5) / f32(GRID_HEIGHT) * 2.0
			out[base + 2] = half_width
			out[base + 3] = half_height
			out[base + 4] = color[0]
			out[base + 5] = color[1]
			out[base + 6] = color[2]
			out[base + 7] = color[3]
			count += 1
		}
	}
	return count
}

CELL_SHADER: string : `
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
  let bevel = 1.04 - smoothstep(0.70, 1.0, edge) * 0.09;
  return vec4<f32>(color.rgb * bevel, color.a);
}
`

// Dawn webgpu C ABI. These layouts match the WGPU library bundled by
// Electrobun and are asserted so an SDK/toolchain mismatch fails at build time.
DEFAULT_SURFACE_FORMAT :: u32(0x0000001b)
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
	next_in_chain:             rawptr,
	count:                     u32,
	mask:                      u32,
	alpha_to_coverage_enabled: b32,
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
	next_in_chain:      rawptr,
	usages:             u64,
	format_count:       uintptr,
	formats:            [^]u32,
	present_mode_count: uintptr,
	present_modes:      [^]u32,
	alpha_mode_count:   uintptr,
	alpha_modes:        [^]u32,
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

string_view :: proc(value: string) -> Wgpu_String_View {
	return {data = raw_data(value), length = u64(len(value))}
}

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
	device_create_shader_module:       Create_Fn,
	device_create_render_pipeline:     Create_Fn,
	device_create_buffer:              Create_Fn,
	device_create_command_encoder:     Create_Fn,
	texture_create_view:               Create_Fn,
	command_encoder_begin_render_pass: Create_Fn,
	render_pass_encoder_set_pipeline:  Set_Pipeline_Fn,
	render_pass_encoder_set_vertex_buffer: Set_Vertex_Buffer_Fn,
	render_pass_encoder_draw:          Draw_Fn,
	render_pass_encoder_end:           End_Fn,
	command_encoder_finish:            Create_Fn,
	queue_write_buffer:                Queue_Write_Buffer_Fn,
	queue_submit:                      Queue_Submit_Fn,
	instance_process_events:           Process_Events_Fn,
	texture_release:                   Release_Fn,
	texture_view_release:              Release_Fn,
	command_buffer_release:            Release_Fn,
	command_encoder_release:           Release_Fn,
	surface_get_capabilities:          Surface_Get_Capabilities_Fn,
	surface_capabilities_free_members: Surface_Capabilities_Free_Members_Fn,
}

wgpu_symbol :: proc(lib: dynlib.Library, name: string) -> (rawptr, bool) {
	ptr, found := dynlib.symbol_address(lib, name)
	if !found {
		fmt.eprintf("[odin-alchemy] missing WGPU symbol: %s\n", name)
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

MAX_PAINT_COMMANDS :: 512

Sim_Params :: struct {
	paused: bool,
}

Gpu_Shared :: struct {
	mutex:           sync.Mutex,
	view_id:         u32,
	host_webview_id: u32,
	width:           u32,
	height:          u32,
	running:         bool,
	reset_requested: bool,
	reset_seed:      u32,
	step_requested:  bool,
	params:          Sim_Params,
	paint_commands:  [MAX_PAINT_COMMANDS]Paint_Command,
	paint_count:     int,
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

app_state :: proc() -> ^App_State {
	if g_state == nil {
		panic("odin-alchemy state not initialized")
	}
	return g_state
}

CORNER_VERTEX_COUNT :: 6
CORNER_STRIDE :: 2 * size_of(f32)
CORNER_BUFFER_SIZE :: CORNER_VERTEX_COUNT * CORNER_STRIDE
INSTANCE_BUFFER_SIZE :: CELL_COUNT * INSTANCE_STRIDE

Gpu_Pipeline :: struct {
	pipeline:        rawptr,
	corner_buffer:   rawptr,
	instance_buffer: rawptr,
}

create_cell_pipeline :: proc(
	api: Wgpu_Api,
	ctx: electrobun.WgpuContext,
	queue: rawptr,
	surface_format: u32,
) -> (pipeline: Gpu_Pipeline, ok: bool) {
	shader_source := Wgpu_Shader_Source_WGSL {
		s_type = STYPE_SHADER_SOURCE_WGSL,
		code = string_view(CELL_SHADER),
	}
	shader_descriptor := Wgpu_Shader_Module_Descriptor {
		next_in_chain = &shader_source,
	}
	shader_module := api.device_create_shader_module(ctx.device_ptr, &shader_descriptor)
	if shader_module == nil {
		fmt.eprintln("[odin-alchemy] failed to create shader module")
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
	color_target := Wgpu_Color_Target_State {
		format = surface_format,
		write_mask = COLOR_WRITE_MASK_ALL,
	}
	fragment_state := Wgpu_Fragment_State {
		module = shader_module,
		entry_point = string_view("fs_main"),
		target_count = 1,
		targets = &color_target,
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
		fmt.eprintln("[odin-alchemy] failed to create render pipeline")
		return {}, false
	}

	corner_descriptor := Wgpu_Buffer_Descriptor {
		usage = BUFFER_USAGE_VERTEX | BUFFER_USAGE_COPY_DST,
		size = CORNER_BUFFER_SIZE,
	}
	pipeline.corner_buffer = api.device_create_buffer(ctx.device_ptr, &corner_descriptor)
	if pipeline.corner_buffer == nil {
		fmt.eprintln("[odin-alchemy] failed to create corner buffer")
		return {}, false
	}
	instance_descriptor := Wgpu_Buffer_Descriptor {
		usage = BUFFER_USAGE_VERTEX | BUFFER_USAGE_COPY_DST,
		size = INSTANCE_BUFFER_SIZE,
	}
	pipeline.instance_buffer = api.device_create_buffer(ctx.device_ptr, &instance_descriptor)
	if pipeline.instance_buffer == nil {
		fmt.eprintln("[odin-alchemy] failed to create instance buffer")
		return {}, false
	}
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
) -> (format: u32, alpha_mode: u32, ok: bool) {
	format = DEFAULT_SURFACE_FORMAT
	alpha_mode = COMPOSITE_ALPHA_MODE_OPAQUE
	capabilities: Wgpu_Surface_Capabilities
	status := api.surface_get_capabilities(ctx.surface_ptr, ctx.adapter_ptr, &capabilities)
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
	width, height, surface_format, alpha_mode: u32,
) -> electrobun.Error {
	config := Wgpu_Surface_Configuration {
		device = ctx.device_ptr,
		format = surface_format,
		usage = TEXTURE_USAGE_RENDER_ATTACHMENT,
		width = width,
		height = height,
		alpha_mode = alpha_mode,
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
		view = texture_view,
		depth_slice = DEPTH_SLICE_UNDEFINED,
		load_op = LOAD_OP_CLEAR,
		store_op = STORE_OP_STORE,
		clear_value = {0.009, 0.010, 0.012, 1.0},
	}
	pass_descriptor := Wgpu_Render_Pass_Descriptor {
		color_attachment_count = 1,
		color_attachments = &color_attachment,
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

send_sim_stats :: proc(
	webview_id: u32,
	fps: f32,
	cells: int,
	tick: u32,
	width, height: u32,
) {
	state := app_state()
	_ = electrobun.sendHostMessageToWebview(
		state.core,
		webview_id,
		struct {
			type: string,
			id: string,
			payload: struct {
				fps: f32,
				cells: int,
				tick: u32,
				width: u32,
				height: u32,
			},
		}{
			type = "message",
			id = "simStats",
			payload = {
				fps = fps,
				cells = cells,
				tick = tick,
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
		fmt.eprintfln("[odin-alchemy] failed to load WGPU library: %v", native_err)
		return
	}
	defer electrobun.close(&native)

	api, api_ok := wgpu_api_load(&native)
	if !api_ok {
		return
	}

	sim := new(Sim)
	defer free(sim)
	sim_reset(sim, DEFAULT_SEED)
	instance_data := make([]f32, CELL_COUNT * FLOATS_PER_INSTANCE)
	defer delete(instance_data)
	pending_paint: [MAX_PAINT_COMMANDS]Paint_Command

	active_view_id: u32
	ctx: electrobun.WgpuContext
	has_context := false
	pipeline: Gpu_Pipeline
	queue: rawptr
	configured_width: u32
	configured_height: u32
	surface_format := DEFAULT_SURFACE_FORMAT
	alpha_mode := COMPOSITE_ALPHA_MODE_OPAQUE
	frame: u64
	fps_value: f32 = 60
	fps_frames: u32
	fps_started := time.tick_now()
	logged_first_frame := false

	for intrinsics.atomic_load(&g_queue_running) {
		sync.mutex_lock(&state.gpu.mutex)
		running := state.gpu.running
		view_id := state.gpu.view_id
		host_webview_id := state.gpu.host_webview_id
		width := state.gpu.width
		height := state.gpu.height
		params := state.gpu.params
		reset_requested := state.gpu.reset_requested
		reset_seed := state.gpu.reset_seed
		step_requested := state.gpu.step_requested
		paint_count := state.gpu.paint_count
		for index in 0 ..< paint_count {
			pending_paint[index] = state.gpu.paint_commands[index]
		}
		state.gpu.paint_count = 0
		state.gpu.reset_requested = false
		state.gpu.step_requested = false
		sync.mutex_unlock(&state.gpu.mutex)

		if !running || view_id == 0 {
			time.sleep(16 * time.Millisecond)
			continue
		}

		if reset_requested {
			sim_reset(sim, reset_seed)
		}
		for index in 0 ..< paint_count {
			apply_paint_command(sim, pending_paint[index])
		}

		if !has_context || active_view_id != view_id {
			new_ctx, ctx_err := electrobun.createForWgpuView(state.core, &native, view_id)
			if ctx_err != .None {
				fmt.eprintfln("[odin-alchemy] failed to create WGPU context: %v", ctx_err)
				time.sleep(250 * time.Millisecond)
				continue
			}
			ctx = new_ctx
			queue = electrobun.getQueue(ctx, &native)
			if queue == nil {
				fmt.eprintln("[odin-alchemy] failed to get WGPU queue")
				time.sleep(250 * time.Millisecond)
				continue
			}
			selected_format, selected_alpha_mode, capabilities_ok :=
				pick_surface_configuration(api, ctx)
			if !capabilities_ok {
				fmt.eprintln("[odin-alchemy] failed to read surface capabilities")
				time.sleep(250 * time.Millisecond)
				continue
			}
			new_pipeline, pipeline_ok := create_cell_pipeline(api, ctx, queue, selected_format)
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
			fmt.printfln("[odin-alchemy] WGPU context ready for view %d", view_id)
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
				fmt.eprintln("[odin-alchemy] failed to configure surface")
				time.sleep(250 * time.Millisecond)
				continue
			}
			configured_width = width
			configured_height = height
		}

		if !params.paused || step_requested {
			sim_step(sim)
		}
		instance_count := pack_instances(sim, instance_data)
		if !render_frame(state.core, api, ctx, pipeline, queue, instance_data, instance_count) {
			time.sleep(100 * time.Millisecond)
			continue
		}
		if !logged_first_frame {
			logged_first_frame = true
			fmt.printfln("[odin-alchemy] first frame submitted (%d cells)", instance_count)
		}

		frame += 1
		fps_frames += 1
		elapsed := time.tick_since(fps_started)
		if elapsed >= time.Second {
			fps_value = f32(fps_frames) / (f32(elapsed) / f32(time.Second))
			fps_frames = 0
			fps_started = time.tick_now()
		}
		if frame % 15 == 0 && host_webview_id != 0 {
			send_sim_stats(host_webview_id, fps_value, sim.occupied, sim.tick, width, height)
		}
		time.sleep(16 * time.Millisecond)
	}
}

ensure_gpu_thread :: proc() {
	if intrinsics.atomic_exchange(&g_gpu_thread_started, true) {
		return
	}
	thread.create_and_start(gpu_render_loop, self_cleanup = true)
}

obj_string :: proc(obj: json.Object, name: string) -> (string, bool) {
	value, found := obj[name]
	if !found {
		return "", false
	}
	result, is_string := value.(json.String)
	if !is_string {
		return "", false
	}
	return result, true
}

obj_f64 :: proc(obj: json.Object, name: string, fallback: f64) -> f64 {
	value, found := obj[name]
	if !found {
		return fallback
	}
	#partial switch number in value {
	case json.Integer:
		return f64(number)
	case json.Float:
		return f64(number)
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
	result, is_bool := value.(json.Boolean)
	if !is_bool {
		return fallback
	}
	return result
}

rect_dimension :: proc(params: json.Object, name: string, fallback: u32) -> u32 {
	value, found := params["rect"]
	if !found {
		return fallback
	}
	rect, is_object := value.(json.Object)
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
			type: string,
			id: u64,
			success: bool,
			payload: struct {ok: bool},
		}{type = "response", id = request_id, success = true, payload = {ok = true}},
	)
	if err != .None {
		fmt.eprintfln("[odin-alchemy] failed to send response: %v", err)
	}
}

send_rpc_error :: proc(webview_id: u32, request_id: u64, message: string) {
	state := app_state()
	_ = electrobun.sendHostMessageToWebview(
		state.core,
		webview_id,
		struct {
			type: string,
			id: u64,
			success: bool,
			error: string,
		}{type = "response", id = request_id, success = false, error = message},
	)
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
	state.gpu.params.paused = obj_bool(params, "paused", state.gpu.params.paused)
	return true
}

enqueue_paint :: proc(state: ^App_State, params: json.Object) {
	material_number := min(obj_u32(params, "material", 0), 6)
	command := Paint_Command {
		from_x = f32(clamp(obj_f64(params, "fromX", 0), 0, 1)),
		from_y = f32(clamp(obj_f64(params, "fromY", 0), 0, 1)),
		to_x = f32(clamp(obj_f64(params, "toX", 0), 0, 1)),
		to_y = f32(clamp(obj_f64(params, "toY", 0), 0, 1)),
		radius = int(clamp(obj_u32(params, "radius", 4), 1, 18)),
		material = Material(material_number),
	}
	sync.mutex_lock(&state.gpu.mutex)
	defer sync.mutex_unlock(&state.gpu.mutex)
	if state.gpu.paint_count < MAX_PAINT_COMMANDS {
		state.gpu.paint_commands[state.gpu.paint_count] = command
		state.gpu.paint_count += 1
	} else {
		state.gpu.paint_commands[MAX_PAINT_COMMANDS - 1] = command
	}
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
		sync.mutex_unlock(&state.gpu.mutex)
		ensure_gpu_thread()
		send_rpc_success(webview_id, request_id)
	case "configureGpu":
		if !params_is_object || !configure_gpu_from_params(state, webview_id, params_obj) {
			send_rpc_error(webview_id, request_id, "InvalidParams")
			return
		}
		send_rpc_success(webview_id, request_id)
	case "resetSim":
		if !params_is_object {
			send_rpc_error(webview_id, request_id, "InvalidParams")
			return
		}
		sync.mutex_lock(&state.gpu.mutex)
		state.gpu.reset_seed = obj_u32(params_obj, "seed", DEFAULT_SEED)
		state.gpu.reset_requested = true
		sync.mutex_unlock(&state.gpu.mutex)
		send_rpc_success(webview_id, request_id)
	case "stepSim":
		sync.mutex_lock(&state.gpu.mutex)
		state.gpu.step_requested = true
		sync.mutex_unlock(&state.gpu.mutex)
		send_rpc_success(webview_id, request_id)
	case:
		send_rpc_error(webview_id, request_id, "Unknown RPC request")
	}
}

handle_rpc_message :: proc(message_id: string, payload: json.Value) {
	if message_id != "paintStroke" {
		return
	}
	params, is_object := payload.(json.Object)
	if is_object {
		enqueue_paint(app_state(), params)
	}
}

handle_host_message :: proc(webview_id: u32, message: cstring) {
	message_string := string(message)
	if len(message_string) == 0 {
		return
	}
	value, parse_err := json.parse_string(message_string, json.DEFAULT_SPECIFICATION, true)
	if parse_err != .None {
		fmt.eprintfln("[odin-alchemy] failed to parse RPC packet: %v", parse_err)
		return
	}
	defer json.destroy_value(value)
	obj, is_object := value.(json.Object)
	if !is_object {
		return
	}
	packet_type, type_ok := obj_string(obj, "type")
	if !type_ok {
		return
	}
	if packet_type == "message" {
		message_id, id_ok := obj_string(obj, "id")
		payload, payload_ok := obj["payload"]
		if id_ok && payload_ok {
			handle_rpc_message(message_id, payload)
		}
		return
	}
	if packet_type != "request" {
		return
	}
	id_value, id_found := obj["id"]
	if !id_found {
		return
	}
	request_id: u64
	#partial switch id in id_value {
	case json.Integer:
		if id < 0 {
			return
		}
		request_id = u64(id)
	case:
		return
	}
	method, method_ok := obj_string(obj, "method")
	params, params_ok := obj["params"]
	if method_ok && params_ok {
		handle_rpc_request(webview_id, request_id, method, params)
	}
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

create_ui :: proc() {
	state := app_state()
	time.sleep(150 * time.Millisecond)
	if err := electrobun.configureWebviewRuntimeFromExecutableDir(state.core, state.bundle_paths, 0);
	   err != .None {
		fmt.eprintfln("[odin-alchemy] failed to configure webview runtime: %v", err)
		return
	}

	window_options := electrobun.defaultWindowOptions("Odin Alchemy Sandbox")
	window_options.frame = {x = 120, y = 80, width = 1160, height = 760}
	window_options.callbacks = {close = main_window_closed}
	window_id, window_err := electrobun.createWindow(state.core, window_options)
	if window_err != .None {
		fmt.eprintfln("[odin-alchemy] failed to create window: %v", window_err)
		return
	}

	webview_options := electrobun.defaultWebviewOptions(window_id)
	webview_options.url = "views://mainview/index.html"
	webview_options.frame = {x = 0, y = 0, width = 1160, height = 760}
	webview_options.secret_key = DEFAULT_SECRET_KEY
	webview_options.sandbox = false
	webview_options.callbacks = {
		decide_navigation = electrobun.allowAllNavigation,
		event = electrobun.noopWebviewEvent,
		event_bridge = electrobun.noopWebviewPostMessage,
		host_bridge = host_bridge,
	}
	webview_id, webview_err := electrobun.createWebview(state.core, webview_options)
	if webview_err != .None {
		fmt.eprintfln("[odin-alchemy] failed to create webview: %v", webview_err)
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
		fmt.eprintfln("[odin-alchemy] failed to load Electrobun core: %v", core_err)
		return
	}
	defer electrobun.close(&core)

	bundle_paths, bundle_err := electrobun.resolveBundlePaths()
	if bundle_err != .None {
		fmt.eprintfln("[odin-alchemy] failed to resolve bundle paths: %v", bundle_err)
		return
	}
	defer electrobun.deinit(&bundle_paths, context.allocator)
	owned_app_info, app_info_err := electrobun.resolveAppInfoFromBundle(context.allocator, &bundle_paths)
	if app_info_err != .None {
		fmt.eprintfln("[odin-alchemy] failed to resolve app info: %v", app_info_err)
		return
	}
	defer electrobun.deinit(&owned_app_info, context.allocator)
	app_info := electrobun.borrowed(owned_app_info)

	state := App_State {
		core = &core,
		bundle_paths = &bundle_paths,
	}
	state.gpu.width = 960
	state.gpu.height = 640
	state.gpu.reset_seed = DEFAULT_SEED
	g_state = &state
	defer g_state = nil

	intrinsics.atomic_store(&g_queue_running, true)
	thread.create_and_start(create_ui, self_cleanup = true)
	thread.create_and_start(drain_host_message_queue, self_cleanup = true)
	defer request_shutdown()
	if err := electrobun.runMainThread(&core, app_info); err != .None {
		fmt.eprintfln("[odin-alchemy] main thread exited with error: %v", err)
	}
}
