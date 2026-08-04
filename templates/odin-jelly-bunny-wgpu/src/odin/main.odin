// Jelly Bunny Lab: deterministic position-based soft-body physics in an
// Odin main process, rendered as layered SDF ellipses on a native WGPU surface.
//
// The browser owns layout, controls, and normalized pointer input. Odin owns
// hit testing, Verlet integration, constraints, collision response, throwing,
// render-part generation, and all Dawn resources.
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

Vec2 :: [2]f32
Vec4 :: [4]f32

v2 :: proc(x, y: f32) -> Vec2 {
	return {x, y}
}

v_add :: proc(a, b: Vec2) -> Vec2 {
	return {a.x + b.x, a.y + b.y}
}

v_sub :: proc(a, b: Vec2) -> Vec2 {
	return {a.x - b.x, a.y - b.y}
}

v_scale :: proc(v: Vec2, scale: f32) -> Vec2 {
	return {v.x * scale, v.y * scale}
}

v_length_sq :: proc(v: Vec2) -> f32 {
	return v.x * v.x + v.y * v.y
}

v_length :: proc(v: Vec2) -> f32 {
	return math.sqrt(v_length_sq(v))
}

v_normalize :: proc(v: Vec2, fallback: Vec2 = {1, 0}) -> Vec2 {
	length := v_length(v)
	if length < 0.00001 {
		return fallback
	}
	return v_scale(v, 1.0 / length)
}

v_perp :: proc(v: Vec2) -> Vec2 {
	return {-v.y, v.x}
}

v_lerp :: proc(a, b: Vec2, t: f32) -> Vec2 {
	return v_add(a, v_scale(v_sub(b, a), t))
}

// ---------------------------------------------------------------------------
// Deterministic Verlet / position-based bunny rig
// ---------------------------------------------------------------------------

BODY_CENTER :: 0
BODY_TOP :: 1
BODY_BOTTOM :: 2
BODY_LEFT :: 3
BODY_RIGHT :: 4
HEAD_CENTER :: 5
HEAD_LEFT :: 6
HEAD_RIGHT :: 7
HEAD_TOP :: 8
EAR_LEFT_BASE :: 9
EAR_LEFT_MID :: 10
EAR_LEFT_TIP :: 11
EAR_RIGHT_BASE :: 12
EAR_RIGHT_MID :: 13
EAR_RIGHT_TIP :: 14
FOOT_LEFT :: 15
FOOT_RIGHT :: 16
ARM_LEFT :: 17
ARM_RIGHT :: 18
TAIL :: 19
NODE_COUNT :: 20
MAX_CONSTRAINTS :: 48

Node :: struct {
	position: Vec2,
	previous: Vec2,
}

Constraint :: struct {
	a, b: int,
	rest: f32,
	soft: bool,
}

Jelly_Params :: struct {
	gravity:   f32,
	squish:   f32,
	stiffness: f32,
	paused:    bool,
}

default_jelly_params :: proc() -> Jelly_Params {
	return {
		gravity = 0.55,
		squish = 0.68,
		stiffness = 0.72,
	}
}

Pointer_Snapshot :: struct {
	x, y:     f32,
	down:     bool,
	pressed:  bool,
	released: bool,
}

Jelly_Sim :: struct {
	nodes:             [NODE_COUNT]Node,
	constraints:       [MAX_CONSTRAINTS]Constraint,
	constraint_count:  int,
	selected:          int,
	grab_target:       Vec2,
	grab_previous:     Vec2,
	frame:             u64,
}

sim_set_node :: proc(sim: ^Jelly_Sim, index: int, position: Vec2) {
	sim.nodes[index] = {position = position, previous = position}
}

sim_add_constraint :: proc(sim: ^Jelly_Sim, a, b: int, soft: bool) {
	if sim.constraint_count >= MAX_CONSTRAINTS {
		return
	}
	delta := v_sub(sim.nodes[b].position, sim.nodes[a].position)
	sim.constraints[sim.constraint_count] = {
		a = a,
		b = b,
		rest = v_length(delta),
		soft = soft,
	}
	sim.constraint_count += 1
}

sim_reset :: proc(sim: ^Jelly_Sim) {
	sim_set_node(sim, BODY_CENTER, v2(0.00, -0.16))
	sim_set_node(sim, BODY_TOP, v2(0.00, 0.10))
	sim_set_node(sim, BODY_BOTTOM, v2(0.00, -0.55))
	sim_set_node(sim, BODY_LEFT, v2(-0.34, -0.18))
	sim_set_node(sim, BODY_RIGHT, v2(0.34, -0.18))
	sim_set_node(sim, HEAD_CENTER, v2(0.00, 0.30))
	sim_set_node(sim, HEAD_LEFT, v2(-0.25, 0.29))
	sim_set_node(sim, HEAD_RIGHT, v2(0.25, 0.29))
	sim_set_node(sim, HEAD_TOP, v2(0.00, 0.52))
	sim_set_node(sim, EAR_LEFT_BASE, v2(-0.14, 0.46))
	sim_set_node(sim, EAR_LEFT_MID, v2(-0.23, 0.68))
	sim_set_node(sim, EAR_LEFT_TIP, v2(-0.27, 0.90))
	sim_set_node(sim, EAR_RIGHT_BASE, v2(0.14, 0.46))
	sim_set_node(sim, EAR_RIGHT_MID, v2(0.23, 0.68))
	sim_set_node(sim, EAR_RIGHT_TIP, v2(0.27, 0.90))
	sim_set_node(sim, FOOT_LEFT, v2(-0.23, -0.63))
	sim_set_node(sim, FOOT_RIGHT, v2(0.23, -0.63))
	sim_set_node(sim, ARM_LEFT, v2(-0.37, -0.22))
	sim_set_node(sim, ARM_RIGHT, v2(0.37, -0.22))
	sim_set_node(sim, TAIL, v2(0.38, -0.30))

	sim.constraint_count = 0

	// Body cage: spokes, perimeter, and cross braces preserve volume while
	// still allowing the silhouette to compress on impact.
	sim_add_constraint(sim, BODY_CENTER, BODY_TOP, true)
	sim_add_constraint(sim, BODY_CENTER, BODY_BOTTOM, true)
	sim_add_constraint(sim, BODY_CENTER, BODY_LEFT, true)
	sim_add_constraint(sim, BODY_CENTER, BODY_RIGHT, true)
	sim_add_constraint(sim, BODY_TOP, BODY_LEFT, true)
	sim_add_constraint(sim, BODY_TOP, BODY_RIGHT, true)
	sim_add_constraint(sim, BODY_BOTTOM, BODY_LEFT, true)
	sim_add_constraint(sim, BODY_BOTTOM, BODY_RIGHT, true)
	sim_add_constraint(sim, BODY_LEFT, BODY_RIGHT, true)
	sim_add_constraint(sim, BODY_TOP, BODY_BOTTOM, true)

	// Head cage and neck.
	sim_add_constraint(sim, BODY_TOP, HEAD_CENTER, false)
	sim_add_constraint(sim, BODY_LEFT, HEAD_LEFT, true)
	sim_add_constraint(sim, BODY_RIGHT, HEAD_RIGHT, true)
	sim_add_constraint(sim, HEAD_CENTER, HEAD_LEFT, true)
	sim_add_constraint(sim, HEAD_CENTER, HEAD_RIGHT, true)
	sim_add_constraint(sim, HEAD_CENTER, HEAD_TOP, true)
	sim_add_constraint(sim, HEAD_LEFT, HEAD_RIGHT, true)
	sim_add_constraint(sim, HEAD_TOP, HEAD_LEFT, true)
	sim_add_constraint(sim, HEAD_TOP, HEAD_RIGHT, true)

	// Articulated ears use triangular chains so they bend without collapsing.
	sim_add_constraint(sim, HEAD_LEFT, EAR_LEFT_BASE, false)
	sim_add_constraint(sim, HEAD_TOP, EAR_LEFT_BASE, false)
	sim_add_constraint(sim, EAR_LEFT_BASE, EAR_LEFT_MID, true)
	sim_add_constraint(sim, EAR_LEFT_MID, EAR_LEFT_TIP, true)
	sim_add_constraint(sim, EAR_LEFT_BASE, EAR_LEFT_TIP, true)
	sim_add_constraint(sim, HEAD_RIGHT, EAR_RIGHT_BASE, false)
	sim_add_constraint(sim, HEAD_TOP, EAR_RIGHT_BASE, false)
	sim_add_constraint(sim, EAR_RIGHT_BASE, EAR_RIGHT_MID, true)
	sim_add_constraint(sim, EAR_RIGHT_MID, EAR_RIGHT_TIP, true)
	sim_add_constraint(sim, EAR_RIGHT_BASE, EAR_RIGHT_TIP, true)

	// Limbs and tail transfer impulses into the body cage.
	sim_add_constraint(sim, BODY_BOTTOM, FOOT_LEFT, true)
	sim_add_constraint(sim, BODY_CENTER, FOOT_LEFT, true)
	sim_add_constraint(sim, BODY_BOTTOM, FOOT_RIGHT, true)
	sim_add_constraint(sim, BODY_CENTER, FOOT_RIGHT, true)
	sim_add_constraint(sim, FOOT_LEFT, FOOT_RIGHT, true)
	sim_add_constraint(sim, BODY_LEFT, ARM_LEFT, true)
	sim_add_constraint(sim, BODY_CENTER, ARM_LEFT, true)
	sim_add_constraint(sim, BODY_RIGHT, ARM_RIGHT, true)
	sim_add_constraint(sim, BODY_CENTER, ARM_RIGHT, true)
	sim_add_constraint(sim, BODY_RIGHT, TAIL, true)
	sim_add_constraint(sim, BODY_CENTER, TAIL, true)

	sim.selected = -1
	sim.grab_target = {}
	sim.grab_previous = {}
	sim.frame = 0
}

solver_iterations :: proc(params: Jelly_Params) -> int {
	return 5 + int(params.stiffness * 7.0)
}

pointer_to_world :: proc(pointer: Pointer_Snapshot, aspect: f32) -> Vec2 {
	return {
		(pointer.x * 2.0 - 1.0) * aspect,
		1.0 - pointer.y * 2.0,
	}
}

sim_handle_pointer :: proc(
	sim: ^Jelly_Sim,
	pointer: Pointer_Snapshot,
	aspect: f32,
) {
	target := pointer_to_world(pointer, aspect)

	if pointer.pressed {
		best := -1
		best_distance_sq := f32(0.34 * 0.34)
		for i in 0 ..< NODE_COUNT {
			distance_sq := v_length_sq(v_sub(sim.nodes[i].position, target))
			if distance_sq < best_distance_sq {
				best = i
				best_distance_sq = distance_sq
			}
		}
		sim.selected = best
		sim.grab_target = target
		sim.grab_previous = target
		if best >= 0 {
			fmt.printfln("[odin-jelly] grabbed physics node %d", best)
		}
	}

	if pointer.down && sim.selected >= 0 {
		delta := v_sub(target, sim.grab_target)
		sim.grab_previous = sim.grab_target
		sim.grab_target = target
		// Keep a bounded amount of cursor velocity in the Verlet history so
		// release produces a natural throw rather than a teleport.
		throw_delta := v_scale(delta, 0.86)
		sim.nodes[sim.selected].position = target
		sim.nodes[sim.selected].previous = v_sub(target, throw_delta)
	}

	if pointer.released {
		if sim.selected >= 0 {
			delta := v_sub(target, sim.grab_target)
			sim.grab_previous = sim.grab_target
			sim.grab_target = target
			sim.nodes[sim.selected].position = target
			sim.nodes[sim.selected].previous = v_sub(target, v_scale(delta, 0.86))
			fmt.printfln("[odin-jelly] released physics node %d", sim.selected)
		}
		sim.selected = -1
	}
}

solve_constraint :: proc(
	sim: ^Jelly_Sim,
	constraint: Constraint,
	params: Jelly_Params,
) {
	a := &sim.nodes[constraint.a]
	b := &sim.nodes[constraint.b]
	delta := v_sub(b.position, a.position)
	distance := v_length(delta)
	if distance < 0.00001 {
		return
	}

	strength := 0.20 + params.stiffness * 0.27
	if constraint.soft {
		strength *= 1.0 - params.squish * 0.58
	}
	correction := v_scale(delta, ((distance - constraint.rest) / distance) * strength)

	a_pinned := sim.selected == constraint.a
	b_pinned := sim.selected == constraint.b
	if a_pinned && b_pinned {
		return
	}
	if a_pinned {
		b.position = v_sub(b.position, correction)
		return
	}
	if b_pinned {
		a.position = v_add(a.position, correction)
		return
	}
	half := v_scale(correction, 0.5)
	a.position = v_add(a.position, half)
	b.position = v_sub(b.position, half)
}

collide_node :: proc(node: ^Node, aspect: f32, squish: f32) {
	margin: f32 = 0.035
	left := -aspect + margin
	right := aspect - margin
	bottom := -1.0 + margin
	top := 1.0 - margin
	restitution := 0.12 + (1.0 - squish) * 0.42
	friction := 0.82 + squish * 0.10
	velocity := v_sub(node.position, node.previous)

	if node.position.x < left {
		node.position.x = left
		velocity.x = -velocity.x * restitution
		velocity.y *= friction
	} else if node.position.x > right {
		node.position.x = right
		velocity.x = -velocity.x * restitution
		velocity.y *= friction
	}
	if node.position.y < bottom {
		node.position.y = bottom
		velocity.y = -velocity.y * restitution
		velocity.x *= friction
	} else if node.position.y > top {
		node.position.y = top
		velocity.y = -velocity.y * restitution
		velocity.x *= friction
	}
	node.previous = v_sub(node.position, velocity)
}

sim_substep :: proc(
	sim: ^Jelly_Sim,
	params: Jelly_Params,
	dt: f32,
	aspect: f32,
) {
	gravity := 0.45 + params.gravity * 4.0
	drag := 0.996 - params.squish * 0.002

	for i in 0 ..< NODE_COUNT {
		if i == sim.selected {
			continue
		}
		node := &sim.nodes[i]
		velocity := v_scale(v_sub(node.position, node.previous), drag)
		node.previous = node.position
		node.position = v_add(node.position, velocity)
		node.position.y -= gravity * dt * dt
	}

	iterations := solver_iterations(params)
	for _ in 0 ..< iterations {
		if sim.selected >= 0 {
			sim.nodes[sim.selected].position = sim.grab_target
		}
		for i in 0 ..< sim.constraint_count {
			solve_constraint(sim, sim.constraints[i], params)
		}
		for i in 0 ..< NODE_COUNT {
			if i != sim.selected {
				collide_node(&sim.nodes[i], aspect, params.squish)
			}
		}
	}

	if sim.selected >= 0 {
		sim.nodes[sim.selected].position = sim.grab_target
	}
}

sim_update :: proc(
	sim: ^Jelly_Sim,
	params: Jelly_Params,
	pointer: Pointer_Snapshot,
	aspect: f32,
) {
	sim_handle_pointer(sim, pointer, aspect)
	if params.paused {
		return
	}

	SUBSTEPS :: 2
	SUBSTEP_DT :: f32(1.0 / 120.0)
	for _ in 0 ..< SUBSTEPS {
		sim_substep(sim, params, SUBSTEP_DT, aspect)
	}
	sim.frame += 1
}

// ---------------------------------------------------------------------------
// Render-part generation
// ---------------------------------------------------------------------------

MAX_RENDER_PARTS :: 32
FLOATS_PER_INSTANCE :: 12
INSTANCE_STRIDE :: FLOATS_PER_INSTANCE * size_of(f32)

pack_instance :: proc(
	out: []f32,
	count: ^int,
	center, axis_x, axis_y: Vec2,
	color: Vec4,
	glow: f32,
	aspect: f32,
) {
	if count^ >= MAX_RENDER_PARTS {
		return
	}
	base := count^ * FLOATS_PER_INSTANCE
	inv_aspect := 1.0 / max(aspect, 0.001)
	out[base + 0] = center.x * inv_aspect
	out[base + 1] = center.y
	out[base + 2] = axis_x.x * inv_aspect
	out[base + 3] = axis_x.y
	out[base + 4] = axis_y.x * inv_aspect
	out[base + 5] = axis_y.y
	out[base + 6] = color.r
	out[base + 7] = color.g
	out[base + 8] = color.b
	out[base + 9] = color.a
	out[base + 10] = glow
	out[base + 11] = 0
	count^ += 1
}

pack_segment :: proc(
	out: []f32,
	count: ^int,
	a, b: Vec2,
	width: f32,
	color: Vec4,
	glow: f32,
	aspect: f32,
) {
	direction := v_sub(b, a)
	axis_y := v_scale(direction, 0.58)
	axis_x := v_scale(v_perp(v_normalize(direction, {0, 1})), width)
	pack_instance(out, count, v_lerp(a, b, 0.5), axis_x, axis_y, color, glow, aspect)
}

pack_bunny :: proc(sim: ^Jelly_Sim, out: []f32, aspect: f32) -> int {
	count := 0
	n := &sim.nodes
	body_center := n[BODY_CENTER].position
	body_x := v_scale(v_sub(n[BODY_RIGHT].position, n[BODY_LEFT].position), 0.56)
	body_y := v_scale(v_sub(n[BODY_TOP].position, n[BODY_BOTTOM].position), 0.57)
	body_x_unit := v_normalize(body_x)
	body_y_unit := v_normalize(body_y, v_perp(body_x_unit))
	head_center := n[HEAD_CENTER].position
	head_x := v_scale(v_sub(n[HEAD_RIGHT].position, n[HEAD_LEFT].position), 0.57)
	head_y := v_scale(v_sub(n[HEAD_TOP].position, head_center), 1.16)
	head_x_unit := v_normalize(head_x)
	head_y_unit := v_normalize(head_y, v_perp(head_x_unit))

	body_color := Vec4{0.28, 0.78, 0.96, 0.95}
	head_color := Vec4{0.43, 0.88, 0.98, 0.97}
	limb_color := Vec4{0.24, 0.69, 0.91, 0.94}
	ear_color := Vec4{0.34, 0.79, 0.97, 0.96}
	inner_ear := Vec4{1.00, 0.42, 0.64, 0.76}
	muzzle_color := Vec4{0.76, 0.96, 1.00, 0.92}
	eye_color := Vec4{0.018, 0.025, 0.060, 0.98}
	white := Vec4{0.95, 1.00, 1.00, 0.98}

	// Shadow and tail sit behind the main silhouette.
	shadow_center := Vec2{body_center.x, -0.91}
	pack_instance(out, &count, shadow_center, v2(0.43, 0), v2(0, 0.07), Vec4{0.01, 0.02, 0.05, 0.52}, 0, aspect)
	pack_instance(out, &count, n[TAIL].position, v_scale(body_x_unit, 0.15), v_scale(body_y_unit, 0.15), head_color, 0.75, aspect)

	// Each ear has two overlapping segments, so the middle physics node creates
	// a visible bend instead of rotating one rigid capsule.
	pack_segment(out, &count, n[EAR_LEFT_BASE].position, n[EAR_LEFT_MID].position, 0.12, ear_color, 0.9, aspect)
	pack_segment(out, &count, n[EAR_LEFT_MID].position, n[EAR_LEFT_TIP].position, 0.10, ear_color, 0.9, aspect)
	pack_segment(out, &count, n[EAR_RIGHT_BASE].position, n[EAR_RIGHT_MID].position, 0.12, ear_color, 0.9, aspect)
	pack_segment(out, &count, n[EAR_RIGHT_MID].position, n[EAR_RIGHT_TIP].position, 0.10, ear_color, 0.9, aspect)

	pack_instance(out, &count, body_center, body_x, body_y, body_color, 1.0, aspect)

	foot_x := v_scale(body_x_unit, 0.19)
	foot_y := v_scale(body_y_unit, 0.105)
	pack_instance(out, &count, n[FOOT_LEFT].position, foot_x, foot_y, limb_color, 0.65, aspect)
	pack_instance(out, &count, n[FOOT_RIGHT].position, foot_x, foot_y, limb_color, 0.65, aspect)
	pack_segment(out, &count, body_center, n[ARM_LEFT].position, 0.10, limb_color, 0.55, aspect)
	pack_segment(out, &count, body_center, n[ARM_RIGHT].position, 0.10, limb_color, 0.55, aspect)

	pack_instance(out, &count, head_center, head_x, head_y, head_color, 1.0, aspect)

	pack_segment(out, &count, v_lerp(n[EAR_LEFT_BASE].position, n[EAR_LEFT_MID].position, 0.08), v_lerp(n[EAR_LEFT_BASE].position, n[EAR_LEFT_MID].position, 0.90), 0.047, inner_ear, 0.15, aspect)
	pack_segment(out, &count, v_lerp(n[EAR_LEFT_MID].position, n[EAR_LEFT_TIP].position, 0.04), v_lerp(n[EAR_LEFT_MID].position, n[EAR_LEFT_TIP].position, 0.82), 0.036, inner_ear, 0.15, aspect)
	pack_segment(out, &count, v_lerp(n[EAR_RIGHT_BASE].position, n[EAR_RIGHT_MID].position, 0.08), v_lerp(n[EAR_RIGHT_BASE].position, n[EAR_RIGHT_MID].position, 0.90), 0.047, inner_ear, 0.15, aspect)
	pack_segment(out, &count, v_lerp(n[EAR_RIGHT_MID].position, n[EAR_RIGHT_TIP].position, 0.04), v_lerp(n[EAR_RIGHT_MID].position, n[EAR_RIGHT_TIP].position, 0.82), 0.036, inner_ear, 0.15, aspect)

	eye_y := v_add(head_center, v_scale(head_y_unit, 0.055))
	left_eye := v_sub(eye_y, v_scale(head_x_unit, 0.105))
	right_eye := v_add(eye_y, v_scale(head_x_unit, 0.105))
	eye_x_axis := v_scale(head_x_unit, 0.045)
	eye_y_axis := v_scale(head_y_unit, 0.066)
	pack_instance(out, &count, left_eye, eye_x_axis, eye_y_axis, eye_color, 0, aspect)
	pack_instance(out, &count, right_eye, eye_x_axis, eye_y_axis, eye_color, 0, aspect)

	glint_axis_x := v_scale(head_x_unit, 0.014)
	glint_axis_y := v_scale(head_y_unit, 0.019)
	glint_offset := v_add(v_scale(head_x_unit, -0.012), v_scale(head_y_unit, 0.018))
	pack_instance(out, &count, v_add(left_eye, glint_offset), glint_axis_x, glint_axis_y, white, 0.2, aspect)
	pack_instance(out, &count, v_add(right_eye, glint_offset), glint_axis_x, glint_axis_y, white, 0.2, aspect)

	muzzle_center := v_sub(head_center, v_scale(head_y_unit, 0.105))
	muzzle_x := v_scale(head_x_unit, 0.105)
	muzzle_y := v_scale(head_y_unit, 0.075)
	pack_instance(out, &count, v_sub(muzzle_center, v_scale(head_x_unit, 0.055)), muzzle_x, muzzle_y, muzzle_color, 0.25, aspect)
	pack_instance(out, &count, v_add(muzzle_center, v_scale(head_x_unit, 0.055)), muzzle_x, muzzle_y, muzzle_color, 0.25, aspect)
	pack_instance(out, &count, v_add(muzzle_center, v_scale(head_y_unit, 0.025)), v_scale(head_x_unit, 0.038), v_scale(head_y_unit, 0.030), Vec4{0.98, 0.26, 0.48, 0.98}, 0.35, aspect)

	return count
}

// ---------------------------------------------------------------------------
// WGSL: layered analytic ellipses with a soft luminous rim
// ---------------------------------------------------------------------------

JELLY_SHADER: string : `
struct VSOut {
  @builtin(position) position : vec4<f32>,
  @location(0) local : vec2<f32>,
  @location(1) color : vec4<f32>,
  @location(2) effect : vec2<f32>,
};

@vertex
fn vs_main(
  @location(0) corner : vec2<f32>,
  @location(1) center : vec2<f32>,
  @location(2) axis_x : vec2<f32>,
  @location(3) axis_y : vec2<f32>,
  @location(4) color : vec4<f32>,
  @location(5) effect : vec2<f32>,
) -> VSOut {
  var out : VSOut;
  out.position = vec4<f32>(center + corner.x * axis_x + corner.y * axis_y, 0.0, 1.0);
  out.local = corner;
  out.color = color;
  out.effect = effect;
  return out;
}

@fragment
fn fs_main(
  @location(0) local : vec2<f32>,
  @location(1) color : vec4<f32>,
  @location(2) effect : vec2<f32>,
) -> @location(0) vec4<f32> {
  let distance = length(local);
  if (distance > 1.0) {
    discard;
  }
  let fill = 1.0 - smoothstep(0.76, 0.88, distance);
  let halo = (1.0 - smoothstep(0.70, 1.0, distance)) * effect.x * 0.32;
  let rim = (1.0 - smoothstep(0.30, 0.88, distance)) * 0.28;
  let alpha = clamp(fill * color.a + halo, 0.0, 1.0);
  let light = 0.78 + rim + effect.x * 0.08;
  return vec4<f32>(color.rgb * light, alpha);
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
		fmt.eprintf("[odin-jelly] missing wgpu symbol: %s\n", name)
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

Pointer_Shared :: struct {
	x, y:     f32,
	down:     bool,
	pressed:  bool,
	released: bool,
}

Gpu_Shared :: struct {
	mutex:           sync.Mutex,
	view_id:         u32,
	host_webview_id: u32,
	width:           u32,
	height:          u32,
	running:         bool,
	reset_requested: bool,
	params:          Jelly_Params,
	pointer:         Pointer_Shared,
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
		panic("odin-jelly state not initialized")
	}
	return g_state
}

// ---------------------------------------------------------------------------
// Pipeline creation and per-frame rendering
// ---------------------------------------------------------------------------

CORNER_VERTEX_COUNT :: 6
CORNER_STRIDE :: 2 * size_of(f32)
CORNER_BUFFER_SIZE :: CORNER_VERTEX_COUNT * CORNER_STRIDE
INSTANCE_BUFFER_SIZE :: MAX_RENDER_PARTS * INSTANCE_STRIDE

Gpu_Pipeline :: struct {
	pipeline:        rawptr,
	corner_buffer:   rawptr,
	instance_buffer: rawptr,
}

create_jelly_pipeline :: proc(
	api: Wgpu_Api,
	ctx: electrobun.WgpuContext,
	queue: rawptr,
	surface_format: u32,
) -> (
	pipeline: Gpu_Pipeline,
	ok: bool,
) {
	shader_source := Wgpu_Shader_Source_WGSL {
		s_type = STYPE_SHADER_SOURCE_WGSL,
		code = string_view(JELLY_SHADER),
	}
	shader_descriptor := Wgpu_Shader_Module_Descriptor {
		next_in_chain = &shader_source,
	}
	shader_module := api.device_create_shader_module(ctx.device_ptr, &shader_descriptor)
	if shader_module == nil {
		fmt.eprintln("[odin-jelly] failed to create shader module")
		return {}, false
	}

	corner_attributes := [1]Wgpu_Vertex_Attribute{
		{format = VERTEX_FORMAT_FLOAT32X2, offset = 0, shader_location = 0},
	}
	instance_attributes := [5]Wgpu_Vertex_Attribute{
		{format = VERTEX_FORMAT_FLOAT32X2, offset = 0, shader_location = 1},
		{format = VERTEX_FORMAT_FLOAT32X2, offset = 8, shader_location = 2},
		{format = VERTEX_FORMAT_FLOAT32X2, offset = 16, shader_location = 3},
		{format = VERTEX_FORMAT_FLOAT32X4, offset = 24, shader_location = 4},
		{format = VERTEX_FORMAT_FLOAT32X2, offset = 40, shader_location = 5},
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
			attribute_count = 5,
			attributes = &instance_attributes[0],
		},
	}

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
		format = surface_format,
		blend = &blend,
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
		fmt.eprintln("[odin-jelly] failed to create render pipeline")
		return {}, false
	}

	corner_descriptor := Wgpu_Buffer_Descriptor {
		usage = BUFFER_USAGE_VERTEX | BUFFER_USAGE_COPY_DST,
		size = CORNER_BUFFER_SIZE,
	}
	pipeline.corner_buffer = api.device_create_buffer(ctx.device_ptr, &corner_descriptor)
	if pipeline.corner_buffer == nil {
		fmt.eprintln("[odin-jelly] failed to create corner buffer")
		return {}, false
	}

	instance_descriptor := Wgpu_Buffer_Descriptor {
		usage = BUFFER_USAGE_VERTEX | BUFFER_USAGE_COPY_DST,
		size = INSTANCE_BUFFER_SIZE,
	}
	pipeline.instance_buffer = api.device_create_buffer(ctx.device_ptr, &instance_descriptor)
	if pipeline.instance_buffer == nil {
		fmt.eprintln("[odin-jelly] failed to create instance buffer")
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
) -> (
	format: u32,
	alpha_mode: u32,
	ok: bool,
) {
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
	width: u32,
	height: u32,
	surface_format: u32,
	alpha_mode: u32,
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
		clear_value = {0.006, 0.009, 0.018, 1.0},
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

// ---------------------------------------------------------------------------
// GPU thread
// ---------------------------------------------------------------------------

send_jelly_frame :: proc(
	webview_id: u32,
	frame: u64,
	fps: f64,
	iterations: int,
	grabbed: bool,
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
				frame: u64,
				fps: f64,
				iterations: int,
				grabbed: bool,
				width: u32,
				height: u32,
			},
		}{
			type = "message",
			id = "jellyFrame",
			payload = {
				frame = frame,
				fps = fps,
				iterations = iterations,
				grabbed = grabbed,
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
		fmt.eprintfln("[odin-jelly] failed to load WGPU library: %v", native_err)
		return
	}
	defer electrobun.close(&native)

	api, api_ok := wgpu_api_load(&native)
	if !api_ok {
		return
	}

	sim := new(Jelly_Sim)
	defer free(sim)
	sim_reset(sim)

	instance_data := make([]f32, MAX_RENDER_PARTS * FLOATS_PER_INSTANCE)
	defer delete(instance_data)

	active_view_id: u32
	ctx: electrobun.WgpuContext
	has_context := false
	pipeline: Gpu_Pipeline
	queue: rawptr
	configured_width: u32
	configured_height: u32
	surface_format := DEFAULT_SURFACE_FORMAT
	alpha_mode := COMPOSITE_ALPHA_MODE_OPAQUE
	logged_first_frame := false
	stats_started := time.tick_now()
	stats_frames: u64
	current_fps: f64 = 60

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
		pointer := Pointer_Snapshot {
			x = state.gpu.pointer.x,
			y = state.gpu.pointer.y,
			down = state.gpu.pointer.down,
			pressed = state.gpu.pointer.pressed,
			released = state.gpu.pointer.released,
		}
		state.gpu.pointer.pressed = false
		state.gpu.pointer.released = false
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
				fmt.eprintfln("[odin-jelly] failed to create WGPU context: %v", ctx_err)
				time.sleep(250 * time.Millisecond)
				continue
			}
			ctx = new_ctx
			queue = electrobun.getQueue(ctx, &native)
			if queue == nil {
				fmt.eprintln("[odin-jelly] failed to get WGPU queue")
				time.sleep(250 * time.Millisecond)
				continue
			}
			selected_format, selected_alpha_mode, capabilities_ok :=
				pick_surface_configuration(api, ctx)
			if !capabilities_ok {
				fmt.eprintln("[odin-jelly] failed to read surface capabilities")
				time.sleep(250 * time.Millisecond)
				continue
			}
			new_pipeline, pipeline_ok := create_jelly_pipeline(api, ctx, queue, selected_format)
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
				"[odin-jelly] WGPU context ready for view %d (format=%d alpha=%d)",
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
				fmt.eprintln("[odin-jelly] failed to configure surface")
				time.sleep(250 * time.Millisecond)
				continue
			}
			configured_width = width
			configured_height = height
		}

		aspect := f32(width) / max(f32(height), 1)
		sim_update(sim, params, pointer, aspect)
		instance_count := pack_bunny(sim, instance_data, aspect)

		if !render_frame(state.core, api, ctx, pipeline, queue, instance_data, instance_count) {
			time.sleep(100 * time.Millisecond)
			continue
		}
		if !logged_first_frame {
			logged_first_frame = true
			fmt.printfln("[odin-jelly] first frame submitted (%d render parts)", instance_count)
		}

		stats_frames += 1
		elapsed := time.tick_since(stats_started)
		if elapsed >= time.Second {
			current_fps = f64(stats_frames) / (f64(elapsed) / f64(time.Second))
			stats_frames = 0
			stats_started = time.tick_now()
		}
		if sim.frame % 15 == 0 && host_webview_id != 0 {
			send_jelly_frame(
				host_webview_id,
				sim.frame,
				current_fps,
				solver_iterations(params),
				sim.selected >= 0,
				width,
				height,
			)
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

// ---------------------------------------------------------------------------
// RPC
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
			type: string,
			id: u64,
			success: bool,
			payload: struct {ok: bool},
		}{type = "response", id = request_id, success = true, payload = {ok = true}},
	)
	if err != .None {
		fmt.eprintfln("[odin-jelly] failed to send response: %v", err)
	}
}

send_rpc_error :: proc(webview_id: u32, request_id: u64, message: string) {
	state := app_state()
	err := electrobun.sendHostMessageToWebview(
		state.core,
		webview_id,
		struct {
			type: string,
			id: u64,
			success: bool,
			error: string,
		}{type = "response", id = request_id, success = false, error = message},
	)
	if err != .None {
		fmt.eprintfln("[odin-jelly] failed to send error response: %v", err)
	}
}

configure_jelly_from_params :: proc(
	state: ^App_State,
	webview_id: u32,
	params: json.Object,
) -> bool {
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
	state.gpu.params.gravity = clamp(f32(obj_f64(params, "gravity", 55)) / 100, 0, 1)
	state.gpu.params.squish = clamp(f32(obj_f64(params, "squish", 68)) / 100, 0, 1)
	state.gpu.params.stiffness = clamp(f32(obj_f64(params, "stiffness", 72)) / 100, 0, 1)
	state.gpu.params.paused = obj_bool(params, "paused", state.gpu.params.paused)
	return true
}

configure_pointer_from_params :: proc(state: ^App_State, params: json.Object) {
	phase := clamp(obj_u32(params, "phase", 1), 0, 2)
	x := clamp(f32(obj_f64(params, "x", 0.5)), 0, 1)
	y := clamp(f32(obj_f64(params, "y", 0.5)), 0, 1)

	sync.mutex_lock(&state.gpu.mutex)
	defer sync.mutex_unlock(&state.gpu.mutex)
	state.gpu.pointer.x = x
	state.gpu.pointer.y = y
	switch phase {
	case 0:
		state.gpu.pointer.down = true
		state.gpu.pointer.pressed = true
		state.gpu.pointer.released = false
	case 1:
	case 2:
		state.gpu.pointer.down = false
		state.gpu.pointer.released = true
	}
}

handle_rpc_request :: proc(
	webview_id: u32,
	request_id: u64,
	method: string,
	params: json.Value,
) {
	state := app_state()
	params_obj, params_is_object := params.(json.Object)

	switch method {
	case "startJelly":
		if !params_is_object || !configure_jelly_from_params(state, webview_id, params_obj) {
			send_rpc_error(webview_id, request_id, "InvalidParams")
			return
		}
		sync.mutex_lock(&state.gpu.mutex)
		state.gpu.running = true
		started_view_id := state.gpu.view_id
		sync.mutex_unlock(&state.gpu.mutex)
		fmt.printfln("[odin-jelly] starting WGPU view %d", started_view_id)
		ensure_gpu_thread()
		send_rpc_success(webview_id, request_id)

	case "configureJelly":
		if !params_is_object || !configure_jelly_from_params(state, webview_id, params_obj) {
			send_rpc_error(webview_id, request_id, "InvalidParams")
			return
		}
		send_rpc_success(webview_id, request_id)

	case "pointerJelly":
		if !params_is_object {
			send_rpc_error(webview_id, request_id, "InvalidParams")
			return
		}
		configure_pointer_from_params(state, params_obj)
		send_rpc_success(webview_id, request_id)

	case "resetJelly":
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
		fmt.eprintfln("[odin-jelly] failed to parse RPC packet: %v", parse_err)
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
		fmt.eprintfln("[odin-jelly] failed to configure webview runtime: %v", err)
		return
	}

	window_options := electrobun.defaultWindowOptions("Jelly Bunny Lab")
	window_options.frame = {x = 150, y = 90, width = 1100, height = 760}
	window_id, window_err := electrobun.createWindow(state.core, window_options)
	if window_err != .None {
		fmt.eprintfln("[odin-jelly] failed to create window: %v", window_err)
		return
	}

	webview_options := electrobun.defaultWebviewOptions(window_id)
	webview_options.url = "views://mainview/index.html"
	webview_options.frame = {x = 0, y = 0, width = 1100, height = 760}
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
		fmt.eprintfln("[odin-jelly] failed to create webview: %v", webview_err)
		_ = electrobun.closeWindow(state.core, window_id)
		return
	}

	// Native main-process SDKs create the shell before the view is attached.
	// Show it explicitly after attachment so startup does not depend on a
	// platform window manager implicitly ordering an initially empty window.
	if show_err := electrobun.showWindow(state.core, window_id, true); show_err != .None {
		fmt.eprintfln("[odin-jelly] failed to show window: %v", show_err)
		_ = electrobun.closeWindow(state.core, window_id)
		return
	}
	fmt.printfln(
		"[odin-jelly] window %d visible=%v with webview %d",
		window_id,
		electrobun.isWindowVisible(state.core, window_id),
		webview_id,
	)

	sync.mutex_lock(&state.mutex)
	state.webview_id = webview_id
	sync.mutex_unlock(&state.mutex)
}

main :: proc() {
	core, core_err := electrobun.load()
	if core_err != .None {
		fmt.eprintfln("[odin-jelly] failed to load Electrobun core: %v", core_err)
		return
	}
	defer electrobun.close(&core)

	bundle_paths, bundle_err := electrobun.resolveBundlePaths()
	if bundle_err != .None {
		fmt.eprintfln("[odin-jelly] failed to resolve bundle paths: %v", bundle_err)
		return
	}
	defer electrobun.deinit(&bundle_paths, context.allocator)

	owned_app_info, app_info_err := electrobun.resolveAppInfoFromBundle(context.allocator, &bundle_paths)
	if app_info_err != .None {
		fmt.eprintfln("[odin-jelly] failed to resolve app info: %v", app_info_err)
		return
	}
	defer electrobun.deinit(&owned_app_info, context.allocator)
	app_info := electrobun.borrowed(owned_app_info)

	state := App_State {
		core = &core,
		bundle_paths = &bundle_paths,
	}
	state.gpu.params = default_jelly_params()
	state.gpu.width = 700
	state.gpu.height = 560
	state.gpu.pointer.x = 0.5
	state.gpu.pointer.y = 0.5

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
		fmt.eprintfln("[odin-jelly] main thread exited with error: %v", err)
	}
}
