// Tree Studio: a deterministic recursive botanical model generated in Odin
// and rendered as instanced tapered branches and leaf billboards on a native
// <electrobun-wgpu> surface. The webview owns controls and layout; Odin owns
// generation, animation, frame timing, and every Dawn resource.
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
// Recursive parametric tree model
// ---------------------------------------------------------------------------

MAX_BRANCHES :: 5_000
MAX_LEAVES :: 12_000
MAX_INSTANCES :: 1 + MAX_BRANCHES + MAX_LEAVES

Vec3 :: struct {
	x, y, z: f32,
}

vec_add :: proc(a, b: Vec3) -> Vec3 {
	return {a.x + b.x, a.y + b.y, a.z + b.z}
}

vec_sub :: proc(a, b: Vec3) -> Vec3 {
	return {a.x - b.x, a.y - b.y, a.z - b.z}
}

vec_scale :: proc(v: Vec3, scale: f32) -> Vec3 {
	return {v.x * scale, v.y * scale, v.z * scale}
}

vec_lerp :: proc(a, b: Vec3, t: f32) -> Vec3 {
	return vec_add(a, vec_scale(vec_sub(b, a), t))
}

vec_dot :: proc(a, b: Vec3) -> f32 {
	return a.x * b.x + a.y * b.y + a.z * b.z
}

vec_cross :: proc(a, b: Vec3) -> Vec3 {
	return {
		a.y * b.z - a.z * b.y,
		a.z * b.x - a.x * b.z,
		a.x * b.y - a.y * b.x,
	}
}

vec_normalize :: proc(v: Vec3) -> Vec3 {
	length := math.sqrt(max(vec_dot(v, v), 0.000001))
	return vec_scale(v, 1.0 / length)
}

Species :: enum u32 {
	Field_Oak   = 0,
	Silver_Birch = 1,
	Alpine_Pine = 2,
}

Tree_Params :: struct {
	seed:         u32,
	species:      Species,
	branching:    f32,
	density:      f32,
	growth_speed: f32,
	wind:         f32,
}

default_tree_params :: proc() -> Tree_Params {
	return {
		seed = 1847,
		species = .Field_Oak,
		branching = 0.68,
		density = 0.76,
		growth_speed = 0.55,
		wind = 0.32,
	}
}

Tree_Profile :: struct {
	max_depth:         int,
	trunk_length:      f32,
	trunk_radius:      f32,
	length_decay:      f32,
	radius_decay:      f32,
	branch_angle:      f32,
	continuation_bend: f32,
	tropism:           f32,
	leaf_size:         f32,
	leaf_spread:       f32,
	bark:              [3]f32,
	leaf:              [3]f32,
}

tree_profile :: proc(species: Species) -> Tree_Profile {
	switch species {
	case .Silver_Birch:
		return {
			max_depth = 9,
			trunk_length = 0.86,
			trunk_radius = 0.105,
			length_decay = 0.735,
			radius_decay = 0.70,
			branch_angle = 0.48,
			continuation_bend = 0.11,
			tropism = 0.18,
			leaf_size = 0.057,
			leaf_spread = 0.18,
			bark = {0.70, 0.68, 0.58},
			leaf = {0.54, 0.72, 0.32},
		}
	case .Alpine_Pine:
		return {
			max_depth = 9,
			trunk_length = 0.90,
			trunk_radius = 0.14,
			length_decay = 0.71,
			radius_decay = 0.69,
			branch_angle = 0.92,
			continuation_bend = 0.055,
			tropism = 0.24,
			leaf_size = 0.050,
			leaf_spread = 0.13,
			bark = {0.30, 0.22, 0.15},
			leaf = {0.19, 0.42, 0.27},
		}
	case .Field_Oak:
		return {
			max_depth = 8,
			trunk_length = 0.96,
			trunk_radius = 0.15,
			length_decay = 0.72,
			radius_decay = 0.68,
			branch_angle = 0.66,
			continuation_bend = 0.16,
			tropism = 0.12,
			leaf_size = 0.068,
			leaf_spread = 0.23,
			bark = {0.37, 0.25, 0.16},
			leaf = {0.42, 0.67, 0.28},
		}
	}
	return {}
}

Branch :: struct {
	start, end:               Vec3,
	start_radius, end_radius: f32,
	depth:                    int,
	phase:                    f32,
	birth_start, birth_end:   f32,
	color_mix:                f32,
}

Leaf :: struct {
	position:  Vec3,
	size:      f32,
	angle:     f32,
	phase:     f32,
	birth:     f32,
	color_mix: f32,
}

Tree :: struct {
	branches:     [MAX_BRANCHES]Branch,
	leaves:       [MAX_LEAVES]Leaf,
	branch_count: int,
	leaf_count:   int,
	rng:          u32,
	profile:      Tree_Profile,
}

// A deterministic xorshift32 keeps every seed reproducible.
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

append_branch :: proc(tree: ^Tree, branch: Branch) {
	if tree.branch_count >= MAX_BRANCHES {
		return
	}
	tree.branches[tree.branch_count] = branch
	tree.branch_count += 1
}

append_leaf :: proc(tree: ^Tree, leaf: Leaf) {
	if tree.leaf_count >= MAX_LEAVES {
		return
	}
	tree.leaves[tree.leaf_count] = leaf
	tree.leaf_count += 1
}

branch_basis :: proc(direction: Vec3) -> (Vec3, Vec3) {
	reference := Vec3{0, 1, 0}
	if abs(direction.y) > 0.92 {
		reference = {1, 0, 0}
	}
	tangent := vec_normalize(vec_cross(direction, reference))
	return tangent, vec_normalize(vec_cross(tangent, direction))
}

angled_direction :: proc(
	direction: Vec3,
	angle, azimuth, upward_pull: f32,
) -> Vec3 {
	tangent, bitangent := branch_basis(direction)
	radial := vec_add(
		vec_scale(tangent, math.cos(azimuth)),
		vec_scale(bitangent, math.sin(azimuth)),
	)
	result := vec_add(
		vec_scale(direction, math.cos(angle)),
		vec_scale(radial, math.sin(angle)),
	)
	result.y += upward_pull
	return vec_normalize(result)
}

add_leaf_cluster :: proc(
	tree: ^Tree,
	position, direction: Vec3,
	depth, max_depth: int,
	density: f32,
) {
	count := 2 + int(density * 9.0)
	if tree.profile.leaf_size < 0.055 {
		count += 2
	}
	birth_base := 0.72 + 0.18 * f32(depth) / f32(max(max_depth, 1))
	for _ in 0 ..< count {
		if tree.leaf_count >= MAX_LEAVES {
			return
		}
		offset := Vec3{
			rand_range(&tree.rng, -1, 1),
			rand_range(&tree.rng, -0.55, 0.8),
			rand_range(&tree.rng, -1, 1),
		}
		offset = vec_scale(
			vec_normalize(vec_add(offset, vec_scale(direction, 0.25))),
			rand_range(&tree.rng, 0.02, tree.profile.leaf_spread),
		)
		append_leaf(
			tree,
			Leaf{
				position = vec_add(position, offset),
				size = tree.profile.leaf_size * rand_range(&tree.rng, 0.72, 1.32),
				angle = rand_range(&tree.rng, -math.PI, math.PI),
				phase = rand_range(&tree.rng, 0, math.TAU),
				birth = clamp(birth_base + rand_range(&tree.rng, -0.035, 0.08), 0.68, 0.96),
				color_mix = rand_f32(&tree.rng),
			},
		)
	}
}

grow_branch :: proc(
	tree: ^Tree,
	start, direction: Vec3,
	length, radius: f32,
	depth, max_depth: int,
	branching, density, phase: f32,
) {
	if tree.branch_count >= MAX_BRANCHES || depth > max_depth {
		return
	}

	profile := tree.profile
	noise := Vec3{
		rand_range(&tree.rng, -profile.continuation_bend, profile.continuation_bend),
		rand_range(&tree.rng, -profile.continuation_bend * 0.35, profile.continuation_bend),
		rand_range(&tree.rng, -profile.continuation_bend, profile.continuation_bend),
	}
	dir := vec_normalize(vec_add(direction, noise))
	end := vec_add(start, vec_scale(dir, length))
	birth_start := 0.035 + f32(depth) / f32(max_depth + 1) * 0.72
	birth_end := 0.035 + f32(depth + 1) / f32(max_depth + 1) * 0.72
	end_radius := max(radius * profile.radius_decay, 0.002)
	append_branch(
		tree,
		Branch{
			start = start,
			end = end,
			start_radius = radius,
			end_radius = end_radius,
			depth = depth,
			phase = phase,
			birth_start = birth_start,
			birth_end = birth_end,
			color_mix = rand_f32(&tree.rng),
		},
	)

	if depth >= max_depth || length < 0.045 {
		add_leaf_cluster(tree, end, dir, depth, max_depth, density)
		return
	}

	continuation_bend := rand_range(
		&tree.rng,
		-profile.continuation_bend,
		profile.continuation_bend,
	)
	continuation := angled_direction(
		dir,
		abs(continuation_bend),
		phase + math.PI * 0.5,
		profile.tropism,
	)
	grow_branch(
		tree,
		end,
		continuation,
		length * profile.length_decay * rand_range(&tree.rng, 0.93, 1.04),
		end_radius,
		depth + 1,
		max_depth,
		branching,
		density,
		phase + 2.39996,
	)

	// Lateral branches use a golden-angle azimuth. Starting them partway
	// along the parent gives a layered crown rather than a binary fractal.
	side_chance := clamp(0.18 + branching * 0.88, 0.25, 0.98)
	if rand_f32(&tree.rng) < side_chance {
		attach := vec_lerp(start, end, rand_range(&tree.rng, 0.48, 0.84))
		angle := profile.branch_angle * rand_range(&tree.rng, 0.76, 1.18)
		if tree.profile.max_depth == 9 && tree.profile.branch_angle > 0.8 {
			angle *= 1.0 - f32(depth) / f32(max_depth + 2) * 0.32
		}
		side_dir := angled_direction(
			dir,
			angle,
			phase + rand_range(&tree.rng, -0.28, 0.28),
			profile.tropism * 0.45,
		)
		grow_branch(
			tree,
			attach,
			side_dir,
			length * profile.length_decay * rand_range(&tree.rng, 0.70, 0.91),
			radius * profile.radius_decay * 0.78,
			depth + 1,
			max_depth,
			branching,
			density,
			phase + 2.39996,
		)
	}

	second_chance := clamp((branching - 0.62) * 1.55, 0, 0.48)
	if depth > 1 && rand_f32(&tree.rng) < second_chance {
		attach := vec_lerp(start, end, rand_range(&tree.rng, 0.38, 0.72))
		side_dir := angled_direction(
			dir,
			profile.branch_angle * rand_range(&tree.rng, 0.82, 1.08),
			phase + math.PI,
			profile.tropism * 0.35,
		)
		grow_branch(
			tree,
			attach,
			side_dir,
			length * profile.length_decay * 0.72,
			radius * profile.radius_decay * 0.72,
			depth + 1,
			max_depth,
			branching,
			density,
			phase + 3.88322,
		)
	}
}

tree_generate :: proc(tree: ^Tree, params: Tree_Params) {
	tree.branch_count = 0
	tree.leaf_count = 0
	tree.rng = params.seed ~ (u32(params.species) + 1) * 0x9E3779B9
	if tree.rng == 0 {
		tree.rng = 0xA341316C
	}
	tree.profile = tree_profile(params.species)

	// Root flare establishes the ground plane before the recursive trunk.
	for i in 0 ..< 5 {
		angle := f32(i) / 5.0 * math.TAU + rand_range(&tree.rng, -0.16, 0.16)
		append_branch(
			tree,
			Branch{
				start = {0, 0.015, 0},
				end = {math.cos(angle) * 0.30, 0, math.sin(angle) * 0.30},
				start_radius = tree.profile.trunk_radius * 0.72,
				end_radius = 0.018,
				depth = 0,
				phase = angle,
				birth_start = 0,
				birth_end = 0.10,
				color_mix = rand_f32(&tree.rng),
			},
		)
	}

	grow_branch(
		tree,
		{0, 0, 0},
		{0.02, 1, 0.01},
		tree.profile.trunk_length,
		tree.profile.trunk_radius,
		0,
		tree.profile.max_depth,
		params.branching,
		params.density,
		rand_range(&tree.rng, 0, math.TAU),
	)
}

smoothstep01 :: proc(value: f32) -> f32 {
	t := clamp(value, 0, 1)
	return t * t * (3 - 2 * t)
}

wind_point :: proc(point: Vec3, clock, strength, phase: f32) -> Vec3 {
	height := clamp(point.y / 3.4, 0, 1)
	weight := height * height * (0.035 + strength * 0.22)
	return {
		point.x + math.sin(clock * 0.82 + point.y * 1.46 + phase) * weight,
		point.y,
		point.z + math.sin(clock * 0.57 + point.y * 1.11 + phase * 0.73) * weight * 0.55,
	}
}

Projected :: struct {
	x, y, depth: f32,
}

project_point :: proc(point: Vec3, aspect, clock: f32) -> Projected {
	yaw := -0.58 + math.sin(clock * 0.09) * 0.075
	cos_yaw := math.cos(yaw)
	sin_yaw := math.sin(yaw)
	rx := point.x * cos_yaw + point.z * sin_yaw
	rz := -point.x * sin_yaw + point.z * cos_yaw
	return {
		x = rx * 0.46 / max(aspect, 0.5),
		y = -0.88 + point.y * 0.48 + rz * 0.022,
		depth = rz,
	}
}

FLOATS_PER_INSTANCE :: 12
INSTANCE_STRIDE :: FLOATS_PER_INSTANCE * size_of(f32)

pack_shape :: proc(
	out: []f32,
	index: int,
	geometry, shape, color: [4]f32,
) {
	base := index * FLOATS_PER_INSTANCE
	for component in 0 ..< 4 {
		out[base + component] = geometry[component]
		out[base + 4 + component] = shape[component]
		out[base + 8 + component] = color[component]
	}
}

pack_instances :: proc(
	tree: ^Tree,
	params: Tree_Params,
	out: []f32,
	aspect, clock, growth: f32,
) -> int {
	count := 0

	// A soft ground shadow anchors the model without another pipeline.
	pack_shape(
		out,
		count,
		{0, -0.885, math.cos(f32(-0.15)), math.sin(f32(-0.15))},
		{0.42, 0.062, aspect, 2},
		{0.01, 0.017, 0.012, 0.55},
	)
	count += 1

	for i in 0 ..< tree.branch_count {
		branch := tree.branches[i]
		if growth <= branch.birth_start {
			continue
		}
		grown := smoothstep01(
			(growth - branch.birth_start) /
				max(branch.birth_end - branch.birth_start, 0.001),
		)
		start := wind_point(branch.start, clock, params.wind, branch.phase)
		partial_end := vec_lerp(branch.start, branch.end, grown)
		end := wind_point(partial_end, clock, params.wind, branch.phase)
		p0 := project_point(start, aspect, clock)
		p1 := project_point(end, aspect, clock)
		depth_light := clamp(0.82 + (p0.depth + p1.depth) * 0.055, 0.64, 1.08)
		variation := (branch.color_mix - 0.5) * 0.11
		bark := tree.profile.bark
		pack_shape(
			out,
			count,
			{p0.x, p0.y, p1.x, p1.y},
			{
				branch.start_radius * 0.46,
				branch.end_radius * (0.28 + grown * 0.72) * 0.46,
				aspect,
				0,
			},
			{
				clamp((bark[0] + variation) * depth_light, 0, 1),
				clamp((bark[1] + variation * 0.7) * depth_light, 0, 1),
				clamp((bark[2] + variation * 0.35) * depth_light, 0, 1),
				clamp(grown * 1.45, 0, 1),
			},
		)
		count += 1
	}

	for i in 0 ..< tree.leaf_count {
		leaf := tree.leaves[i]
		if growth <= leaf.birth {
			continue
		}
		fade := smoothstep01((growth - leaf.birth) / 0.11)
		position := wind_point(leaf.position, clock, params.wind, leaf.phase)
		projected := project_point(position, aspect, clock)
		angle := leaf.angle + math.sin(clock * 1.15 + leaf.phase) * params.wind * 0.18
		depth_light := clamp(0.83 + projected.depth * 0.08, 0.68, 1.12)
		variation := (leaf.color_mix - 0.5) * 0.20
		green := tree.profile.leaf
		pack_shape(
			out,
			count,
			{projected.x, projected.y, math.cos(angle), math.sin(angle)},
			{leaf.size * 0.58, leaf.size, aspect, 1},
			{
				clamp((green[0] + variation * 0.55) * depth_light, 0, 1),
				clamp((green[1] + variation) * depth_light, 0, 1),
				clamp((green[2] + variation * 0.42) * depth_light, 0, 1),
				fade * 0.96,
			},
		)
		count += 1
	}
	return count
}

// ---------------------------------------------------------------------------
// WGSL shader: tapered branch ribbons and softly lit leaf billboards
// ---------------------------------------------------------------------------

TREE_SHADER: string : `
struct VSOut {
  @builtin(position) position : vec4<f32>,
  @location(0) local : vec2<f32>,
  @location(1) color : vec4<f32>,
  @location(2) kind : f32,
};

@vertex
fn vs_main(
  @location(0) corner : vec2<f32>,
  @location(1) geometry : vec4<f32>,
  @location(2) shape : vec4<f32>,
  @location(3) color : vec4<f32>
) -> VSOut {
  var out : VSOut;
  let aspect = shape.z;
  let kind = shape.w;
  var position : vec2<f32>;

  if (kind < 0.5) {
    let start = geometry.xy;
    let finish = geometry.zw;
    let delta_px = vec2<f32>((finish.x - start.x) * aspect, finish.y - start.y);
    let tangent = normalize(delta_px + vec2<f32>(0.000001, 0.0));
    let normal = vec2<f32>(-tangent.y, tangent.x);
    let along = corner.y * 0.5 + 0.5;
    let radius = mix(shape.x, shape.y, along);
    let offset_px = normal * corner.x * radius;
    position = mix(start, finish, along) + vec2<f32>(offset_px.x / aspect, offset_px.y);
  } else {
    let axis = geometry.zw;
    let across = vec2<f32>(-axis.y, axis.x);
    let offset_px = across * corner.x * shape.x + axis * corner.y * shape.y;
    position = geometry.xy + vec2<f32>(offset_px.x / aspect, offset_px.y);
  }

  out.position = vec4<f32>(position, 0.0, 1.0);
  out.local = corner;
  out.color = color;
  out.kind = kind;
  return out;
}

@fragment
fn fs_main(
  @location(0) local : vec2<f32>,
  @location(1) color : vec4<f32>,
  @location(2) kind : f32,
) -> @location(0) vec4<f32> {
  if (kind < 0.5) {
    let edge = smoothstep(1.0, 0.72, abs(local.x));
    let bark_light = 0.82 + (local.x + 1.0) * 0.09;
    return vec4<f32>(color.rgb * bark_light, color.a * edge);
  }

  let leaf_d2 = dot(local, local);
  if (leaf_d2 > 1.0) {
    discard;
  }
  let edge = smoothstep(1.0, 0.72, leaf_d2);
  if (kind > 1.5) {
    return vec4<f32>(color.rgb, color.a * edge);
  }
  let vein = 1.0 - smoothstep(0.015, 0.075, abs(local.x));
  let light = 0.88 + (local.x * -0.08 + local.y * 0.12) + vein * 0.16;
  return vec4<f32>(color.rgb * light, color.a * edge);
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
BLEND_FACTOR_ZERO :: u32(0x00000001)
BLEND_FACTOR_ONE :: u32(0x00000002)
BLEND_FACTOR_SRC_ALPHA :: u32(0x00000005)
BLEND_FACTOR_ONE_MINUS_SRC_ALPHA :: u32(0x00000006)
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
		fmt.eprintf("[odin-tree] missing wgpu symbol: %s\n", name)
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
	regenerate_requested: bool,
	restart_requested:    bool,
	params:               Tree_Params,
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
		panic("odin-tree state not initialized")
	}
	return g_state
}

// ---------------------------------------------------------------------------
// Pipeline creation and per-frame rendering
// ---------------------------------------------------------------------------

CORNER_VERTEX_COUNT :: 6
CORNER_STRIDE :: 2 * size_of(f32)
CORNER_BUFFER_SIZE :: CORNER_VERTEX_COUNT * CORNER_STRIDE
INSTANCE_BUFFER_SIZE :: MAX_INSTANCES * INSTANCE_STRIDE

Gpu_Pipeline :: struct {
	pipeline:        rawptr,
	corner_buffer:   rawptr,
	instance_buffer: rawptr,
}

create_tree_pipeline :: proc(
	api: Wgpu_Api,
	ctx: electrobun.WgpuContext,
	queue: rawptr,
	surface_format: u32,
) -> (
	pipeline: Gpu_Pipeline,
	ok: bool,
) {
	shader_code := TREE_SHADER
	shader_source := Wgpu_Shader_Source_WGSL {
		s_type = STYPE_SHADER_SOURCE_WGSL,
		code   = string_view(shader_code),
	}
	shader_descriptor := Wgpu_Shader_Module_Descriptor {
		next_in_chain = &shader_source,
	}
	shader_module := api.device_create_shader_module(ctx.device_ptr, &shader_descriptor)
	if shader_module == nil {
		fmt.eprintln("[odin-tree] failed to create shader module")
		return {}, false
	}

	corner_attributes := [1]Wgpu_Vertex_Attribute{
		{format = VERTEX_FORMAT_FLOAT32X2, offset = 0, shader_location = 0},
	}
	instance_attributes := [3]Wgpu_Vertex_Attribute{
		{format = VERTEX_FORMAT_FLOAT32X4, offset = 0, shader_location = 1},
		{format = VERTEX_FORMAT_FLOAT32X4, offset = 16, shader_location = 2},
		{format = VERTEX_FORMAT_FLOAT32X4, offset = 32, shader_location = 3},
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

	// Standard alpha compositing preserves bark and leaf color variation.
	blend := Wgpu_Blend_State {
		color = {
			operation = BLEND_OPERATION_ADD,
			src_factor = BLEND_FACTOR_SRC_ALPHA,
			dst_factor = BLEND_FACTOR_ONE_MINUS_SRC_ALPHA,
		},
		alpha = {
			operation = BLEND_OPERATION_ADD,
			src_factor = BLEND_FACTOR_ONE,
			dst_factor = BLEND_FACTOR_ONE_MINUS_SRC_ALPHA,
		},
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
		fmt.eprintln("[odin-tree] failed to create render pipeline")
		return {}, false
	}

	corner_descriptor := Wgpu_Buffer_Descriptor {
		usage = BUFFER_USAGE_VERTEX | BUFFER_USAGE_COPY_DST,
		size  = CORNER_BUFFER_SIZE,
	}
	pipeline.corner_buffer = api.device_create_buffer(ctx.device_ptr, &corner_descriptor)
	if pipeline.corner_buffer == nil {
		fmt.eprintln("[odin-tree] failed to create corner buffer")
		return {}, false
	}

	instance_descriptor := Wgpu_Buffer_Descriptor {
		usage = BUFFER_USAGE_VERTEX | BUFFER_USAGE_COPY_DST,
		size  = INSTANCE_BUFFER_SIZE,
	}
	pipeline.instance_buffer = api.device_create_buffer(ctx.device_ptr, &instance_descriptor)
	if pipeline.instance_buffer == nil {
		fmt.eprintln("[odin-tree] failed to create instance buffer")
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
		clear_value = {0.012, 0.019, 0.014, 1.0},
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
// GPU thread: grow + render at ~60fps
// ---------------------------------------------------------------------------

send_tree_frame :: proc(
	webview_id, view_id: u32,
	frame: u64,
	width, height: u32,
	branches, leaves: int,
	growth: f32,
) {
	state := app_state()
	_ = electrobun.sendHostMessageToWebview(
		state.core,
		webview_id,
		struct {
			type:    string,
			id:      string,
			payload: struct {
				id:       u32,
				frame:    u64,
				width:    u32,
				height:   u32,
				branches: int,
				leaves:   int,
				growth:   f32,
			},
		}{
			type = "message",
			id = "treeFrame",
			payload = {
				id = view_id,
				frame = frame,
				width = width,
				height = height,
				branches = branches,
				leaves = leaves,
				growth = growth,
			},
		},
	)
}

gpu_render_loop :: proc() {
	state := app_state()

	native, native_err := electrobun.wgpuNativeLoad()
	if native_err != .None {
		fmt.eprintfln("[odin-tree] failed to load WGPU library: %v", native_err)
		return
	}
	defer electrobun.close(&native)

	api, api_ok := wgpu_api_load(&native)
	if !api_ok {
		return
	}

	tree := new(Tree)
	defer free(tree)

	instance_data := make([]f32, MAX_INSTANCES * FLOATS_PER_INSTANCE)
	defer delete(instance_data)

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
	logged_mature_frame := false
	clock: f32
	growth: f32

	DT :: f32(1.0 / 60.0)

	for intrinsics.atomic_load(&g_queue_running) {
		sync.mutex_lock(&state.gpu.mutex)
		running := state.gpu.running
		view_id := state.gpu.view_id
		host_webview_id := state.gpu.host_webview_id
		width := state.gpu.width
		height := state.gpu.height
		params := state.gpu.params
		regenerate_requested := state.gpu.regenerate_requested
		restart_requested := state.gpu.restart_requested
		state.gpu.regenerate_requested = false
		state.gpu.restart_requested = false
		sync.mutex_unlock(&state.gpu.mutex)

		if !running || view_id == 0 {
			time.sleep(16 * time.Millisecond)
			continue
		}

		if regenerate_requested {
			tree_generate(tree, params)
			growth = 0
			logged_mature_frame = false
			fmt.printfln(
				"[odin-tree] generated seed %d (%d branches, %d leaves)",
				params.seed,
				tree.branch_count,
				tree.leaf_count,
			)
		} else if restart_requested {
			growth = 0
			logged_mature_frame = false
		}

		if !has_context || active_view_id != view_id {
			new_ctx, ctx_err := electrobun.createForWgpuView(state.core, &native, view_id)
			if ctx_err != .None {
				fmt.eprintfln("[odin-tree] failed to create WGPU context: %v", ctx_err)
				time.sleep(250 * time.Millisecond)
				continue
			}
			ctx = new_ctx
			queue = electrobun.getQueue(ctx, &native)
			if queue == nil {
				fmt.eprintln("[odin-tree] failed to get WGPU queue")
				time.sleep(250 * time.Millisecond)
				continue
			}
			selected_format, selected_alpha_mode, capabilities_ok :=
				pick_surface_configuration(api, ctx)
			if !capabilities_ok {
				fmt.eprintln("[odin-tree] failed to read surface capabilities")
				time.sleep(250 * time.Millisecond)
				continue
			}
			new_pipeline, pipeline_ok := create_tree_pipeline(
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
			logged_mature_frame = false
			fmt.printfln(
				"[odin-tree] WGPU context ready for view %d (format=%d alpha=%d)",
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
				fmt.eprintln("[odin-tree] failed to configure surface")
				time.sleep(250 * time.Millisecond)
				continue
			}
			configured_width = width
			configured_height = height
		}

		aspect := f32(width) / max(f32(height), 1)
		clock += DT
		growth = min(growth + DT * (0.055 + params.growth_speed * 0.31), 1)
		instance_count := pack_instances(tree, params, instance_data, aspect, clock, growth)

		if !render_frame(state.core, api, ctx, pipeline, queue, instance_data, instance_count) {
			time.sleep(100 * time.Millisecond)
			continue
		}
		if !logged_first_frame {
			logged_first_frame = true
			fmt.printfln(
				"[odin-tree] first frame submitted (%d instances)",
				instance_count,
			)
		}
		if !logged_mature_frame && growth >= 0.99 {
			logged_mature_frame = true
			fmt.printfln(
				"[odin-tree] mature frame submitted (%d instances)",
				instance_count,
			)
		}

		if frame % 30 == 0 && host_webview_id != 0 {
			send_tree_frame(
				host_webview_id,
				view_id,
				frame,
				width,
				height,
				tree.branch_count,
				tree.leaf_count,
				growth,
			)
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
		fmt.eprintfln("[odin-tree] failed to send response: %v", err)
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
		fmt.eprintfln("[odin-tree] failed to send error response: %v", err)
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
	state.gpu.params.seed = max(obj_u32(params, "seed", state.gpu.params.seed), 1)
	state.gpu.params.species = Species(
		min(obj_u32(params, "species", u32(state.gpu.params.species)), 2),
	)
	state.gpu.params.branching = clamp(
		f32(obj_f64(params, "branching", f64(state.gpu.params.branching) * 100)) / 100,
		0.2,
		1,
	)
	state.gpu.params.density = clamp(
		f32(obj_f64(params, "density", f64(state.gpu.params.density) * 100)) / 100,
		0.1,
		1,
	)
	state.gpu.params.growth_speed = clamp(
		f32(obj_f64(params, "growth", f64(state.gpu.params.growth_speed) * 100)) / 100,
		0.05,
		1,
	)
	state.gpu.params.wind = clamp(
		f32(obj_f64(params, "wind", f64(state.gpu.params.wind) * 100)) / 100,
		0,
		1,
	)
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
		state.gpu.regenerate_requested = true
		started_view_id := state.gpu.view_id
		started_width := state.gpu.width
		started_height := state.gpu.height
		sync.mutex_unlock(&state.gpu.mutex)
		fmt.printfln(
			"[odin-tree] starting WGPU view %d at %dx%d",
			started_view_id,
			started_width,
			started_height,
		)
		ensure_gpu_thread()
		send_rpc_success(webview_id, request_id)

	case "configureGpu":
		if !params_is_object || !configure_gpu_from_params(state, webview_id, params_obj) {
			send_rpc_error(webview_id, request_id, "InvalidParams")
			return
		}
		send_rpc_success(webview_id, request_id)

	case "regenerateTree":
		if !params_is_object || !configure_gpu_from_params(state, webview_id, params_obj) {
			send_rpc_error(webview_id, request_id, "InvalidParams")
			return
		}
		sync.mutex_lock(&state.gpu.mutex)
		state.gpu.regenerate_requested = true
		sync.mutex_unlock(&state.gpu.mutex)
		send_rpc_success(webview_id, request_id)

	case "restartGrowth":
		sync.mutex_lock(&state.gpu.mutex)
		state.gpu.restart_requested = true
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
		fmt.eprintfln("[odin-tree] failed to parse RPC packet: %v", parse_err)
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
		fmt.eprintfln("[odin-tree] failed to configure webview runtime: %v", err)
		return
	}

	window_options := electrobun.defaultWindowOptions("Tree Studio")
	window_options.frame = {x = 150, y = 90, width = 1120, height = 740}
	window_id, window_err := electrobun.createWindow(state.core, window_options)
	if window_err != .None {
		fmt.eprintfln("[odin-tree] failed to create window: %v", window_err)
		return
	}

	webview_options := electrobun.defaultWebviewOptions(window_id)
	webview_options.url = "views://mainview/index.html"
	webview_options.frame = {x = 0, y = 0, width = 1120, height = 740}
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
		fmt.eprintfln("[odin-tree] failed to create webview: %v", webview_err)
		_ = electrobun.closeWindow(state.core, window_id)
		return
	}
	if show_err := electrobun.showWindow(state.core, window_id, true); show_err != .None {
		fmt.eprintfln("[odin-tree] failed to show window: %v", show_err)
	}

	sync.mutex_lock(&state.mutex)
	state.webview_id = webview_id
	sync.mutex_unlock(&state.mutex)
}

main :: proc() {
	core, core_err := electrobun.load()
	if core_err != .None {
		fmt.eprintfln("[odin-tree] failed to load Electrobun core: %v", core_err)
		return
	}
	defer electrobun.close(&core)

	bundle_paths, bundle_err := electrobun.resolveBundlePaths()
	if bundle_err != .None {
		fmt.eprintfln("[odin-tree] failed to resolve bundle paths: %v", bundle_err)
		return
	}
	defer electrobun.deinit(&bundle_paths, context.allocator)

	owned_app_info, app_info_err := electrobun.resolveAppInfoFromBundle(context.allocator, &bundle_paths)
	if app_info_err != .None {
		fmt.eprintfln("[odin-tree] failed to resolve app info: %v", app_info_err)
		return
	}
	defer electrobun.deinit(&owned_app_info, context.allocator)
	app_info := electrobun.borrowed(owned_app_info)

	state := App_State {
		core         = &core,
		bundle_paths = &bundle_paths,
	}
	state.gpu.params = default_tree_params()
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
		fmt.eprintfln("[odin-tree] main thread exited with error: %v", err)
	}
}
