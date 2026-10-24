// Electrobun UI renderer shaders. Mirrors render/sdf.zig.

struct Uniforms {
  viewport: vec4f, // device w, h, scale, 0
};

struct Prim {
  bounds: vec4f,
  rect: vec4f,
  radii: vec4f,   // tl tr br bl
  color: vec4f,
  c1: vec4f,
  c2: vec4f,
  c3: vec4f,
  params: vec4f,
  xf0: vec4f,     // a b c d
  xf1: vec4f,     // e f kind flags
  clip: vec4f,    // device x0 y0 x1 y1
  clip_rect: vec4f,
  clip_radii: vec4f,
  uv: vec4f,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> prims: array<Prim>;
@group(0) @binding(2) var atlas: texture_2d<f32>;
@group(0) @binding(3) var color_atlas: texture_2d<f32>;
@group(0) @binding(4) var lut: texture_2d<f32>;
@group(0) @binding(5) var samp: sampler;
@group(1) @binding(0) var tex: texture_2d<f32>;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,
  @location(1) @interpolate(flat) idx: u32,
  @location(2) quv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let p = prims[ii];
  let corner = vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u));
  let local = p.bounds.xy + corner * p.bounds.zw;
  let css = vec2f(p.xf0.x * local.x + p.xf0.z * local.y + p.xf1.x,
                  p.xf0.y * local.x + p.xf0.w * local.y + p.xf1.y);
  let dev = css * u.viewport.z;
  var out: VOut;
  out.pos = vec4f(dev.x / u.viewport.x * 2.0 - 1.0, 1.0 - dev.y / u.viewport.y * 2.0, 0.0, 1.0);
  out.local = local;
  out.idx = ii;
  out.quv = corner;
  return out;
}

fn sdRoundRect(p: vec2f, r: vec4f, radii: vec4f) -> f32 {
  let hw = r.zw * 0.5;
  let q0 = p - (r.xy + hw);
  var rad: f32;
  if (q0.x < 0.0) {
    rad = select(radii.w, radii.x, q0.y < 0.0);
  } else {
    rad = select(radii.z, radii.y, q0.y < 0.0);
  }
  let q = abs(q0) - hw + vec2f(rad);
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - rad;
}

fn erf(x: f32) -> f32 {
  let s = sign(x);
  let a = abs(x);
  let t = 1.0 / (1.0 + 0.3275911 * a);
  let y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-a * a);
  return s * y;
}

fn borderSide(p: vec2f, r: vec4f, w: vec4f) -> u32 {
  // w = top right bottom left
  let dt = (p.y - r.y) / max(w.x, 0.001);
  let dr = (r.x + r.z - p.x) / max(w.y, 0.001);
  let db = (r.y + r.w - p.y) / max(w.z, 0.001);
  let dl = (p.x - r.x) / max(w.w, 0.001);
  var best = 0u;
  var bd = select(1e9, dt, w.x > 0.0);
  if (w.y > 0.0 && dr < bd) { bd = dr; best = 1u; }
  if (w.z > 0.0 && db < bd) { bd = db; best = 2u; }
  if (w.w > 0.0 && dl < bd) { best = 3u; }
  return best;
}

fn dashMask(p: vec2f, r: vec4f, side: u32, width: f32, dotted: bool) -> f32 {
  var pos = p.y - r.y;
  if (side == 0u || side == 2u) { pos = p.x - r.x; }
  let w = max(width, 1.0);
  if (dotted) {
    let period = 2.0 * w;
    let m = pos - floor(pos / period) * period;
    var across = p.x - r.x;
    if (side == 0u) { across = p.y - r.y; }
    if (side == 2u) { across = r.y + r.w - p.y; }
    if (side == 1u) { across = r.x + r.z - p.x; }
    let d = length(vec2f(m - w * 0.5, across - w * 0.5)) - w * 0.5;
    return clamp(0.5 - d, 0.0, 1.0);
  }
  let period = 6.0 * w;
  let m = pos - floor(pos / period) * period;
  return select(0.0, 1.0, m < 3.0 * w);
}

@fragment
fn fs_main(in: VOut) -> @location(0) vec4f {
  let p = prims[in.idx];
  let kind = u32(p.xf1.z);
  let det = abs(p.xf0.x * p.xf0.w - p.xf0.y * p.xf0.z);
  let s = sqrt(det) * u.viewport.z; // device px per local unit
  let lp = in.local;

  // clipping
  let dp = in.pos.xy;
  var cov = clamp(min(min(dp.x - p.clip.x, p.clip.z - dp.x), min(dp.y - p.clip.y, p.clip.w - dp.y)) + 0.5, 0.0, 1.0);
  if (p.xf1.w > 0.5) {
    cov = cov * clamp(0.5 - sdRoundRect(lp, p.clip_rect, p.clip_radii) * s, 0.0, 1.0);
  }
  if (cov <= 0.0) { discard; }

  var color = vec4f(0.0);
  switch kind {
    case 0u: { // rect
      let d = sdRoundRect(lp, p.rect, p.radii) * s;
      color = p.color * clamp(0.5 - d, 0.0, 1.0);
    }
    case 1u: { // border
      let w = p.params;
      let inner = vec4f(p.rect.x + w.w, p.rect.y + w.x, p.rect.z - w.w - w.y, p.rect.w - w.x - w.z);
      let ir = max(vec4f(0.0), p.radii - vec4f(max(w.w, w.x), max(w.y, w.x), max(w.y, w.z), max(w.w, w.z)));
      let d_out = sdRoundRect(lp, p.rect, p.radii) * s;
      let d_in = sdRoundRect(lp, inner, ir) * s;
      var c = max(0.0, clamp(0.5 - d_out, 0.0, 1.0) - clamp(0.5 - d_in, 0.0, 1.0));
      let side = borderSide(lp, p.rect, w);
      var sc = p.color;
      var sw = w.x;
      var st = p.uv.x;
      if (side == 1u) { sc = p.c1; sw = w.y; st = p.uv.y; }
      if (side == 2u) { sc = p.c2; sw = w.z; st = p.uv.z; }
      if (side == 3u) { sc = p.c3; sw = w.w; st = p.uv.w; }
      if (st > 0.5) { c = c * dashMask(lp, p.rect, side, sw, st > 1.5); }
      color = sc * c;
    }
    case 2u: { // shadow
      let sigma = p.params.x;
      let d = sdRoundRect(lp, p.rect, p.radii);
      var a: f32;
      if (sigma < 0.01) {
        a = clamp(0.5 - d * s, 0.0, 1.0);
      } else {
        a = 0.5 * (1.0 - erf(d / (1.41421356 * sigma)));
      }
      let box_d = sdRoundRect(lp, p.c1, p.c2) * s;
      var c: f32;
      if (p.params.y > 0.5) {
        c = clamp(0.5 - box_d, 0.0, 1.0) * (1.0 - a);
      } else {
        c = a * clamp(0.5 + box_d, 0.0, 1.0);
      }
      color = p.color * c;
    }
    case 3u: { // gradient
      let d = max(sdRoundRect(lp, p.rect, p.radii), sdRoundRect(lp, p.rect, vec4f(0.0))) * s;
      let c = clamp(0.5 - d, 0.0, 1.0);
      let gk = u32(p.c2.w);
      var t: f32;
      if (gk == 0u) {
        t = dot(lp - p.c1.xy, p.c1.zw) / p.c2.x + 0.5;
      } else if (gk == 1u) {
        t = length((lp - p.c1.xy) / p.c2.yz);
      } else {
        var a = atan2(lp.x - p.c1.x, -(lp.y - p.c1.y)) - p.params.x;
        a = a - floor(a / 6.2831853) * 6.2831853;
        t = a / 6.2831853;
      }
      if (p.c3.w > 0.5) {
        let span = p.c3.z - p.c3.y;
        if (span > 0.0001) { t = p.c3.y + (t - p.c3.y) - floor((t - p.c3.y) / span) * span; }
      }
      t = clamp(t, 0.0, 1.0);
      let g = textureSampleLevel(lut, samp, vec2f(t * (255.0 / 256.0) + 0.5 / 256.0, p.c3.x), 0.0);
      color = g * c;
    }
    case 4u: { // glyph (coverage atlas)
      let uv = p.uv.xy + in.quv * p.uv.zw;
      let a = textureSampleLevel(atlas, samp, uv, 0.0).r;
      color = p.color * a;
    }
    case 5u: { // color glyph
      let uv = p.uv.xy + in.quv * p.uv.zw;
      color = textureSampleLevel(color_atlas, samp, uv, 0.0) * p.color.a;
    }
    case 6u: { // image
      let d = sdRoundRect(lp, p.rect, p.radii) * s;
      let c = clamp(0.5 - d, 0.0, 1.0);
      let uv = p.uv.xy + (lp - p.rect.xy) / p.rect.zw * p.uv.zw;
      color = textureSampleLevel(tex, samp, uv, 0.0) * p.params.x * c;
    }
    default: { // layer composite (device-space sampling)
      let uv = dp / u.viewport.xy;
      var c = textureSampleLevel(tex, samp, uv, 0.0);
      if (p.params.y > 0.5 && c.a > 0.0) {
        let rgb = c.rgb / c.a;
        let o = vec3f(dot(p.color.xyz, rgb) + p.color.w, dot(p.c1.xyz, rgb) + p.c1.w, dot(p.c2.xyz, rgb) + p.c2.w);
        c = vec4f(clamp(o, vec3f(0.0), vec3f(1.0)) * c.a, c.a);
      }
      var m = p.params.x;
      if (p.params.z > 0.5) {
        m = m * clamp(0.5 - sdRoundRect(lp, p.c3, p.clip_radii) * s, 0.0, 1.0);
      }
      color = c * m;
    }
  }
  return color * cov;
}

// ---------------------------------------------------------------------------
// Fullscreen passes: blur and blit
// ---------------------------------------------------------------------------

struct BlurU {
  p: vec4f, // sigma, horizontal, w, h
};
@group(0) @binding(0) var<uniform> bu: BlurU;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var src_samp: sampler;

struct FOut {
  @builtin(position) pos: vec4f,
};

@vertex
fn vs_fullscreen(@builtin(vertex_index) vi: u32) -> FOut {
  let x = f32((vi << 1u) & 2u) * 2.0 - 1.0;
  let y = f32(vi & 2u) * 2.0 - 1.0;
  var o: FOut;
  o.pos = vec4f(x, y, 0.0, 1.0);
  return o;
}

@fragment
fn fs_blur(in: FOut) -> @location(0) vec4f {
  let sigma = max(bu.p.x, 0.01);
  let size = bu.p.zw;
  var dir = vec2f(0.0, 1.0);
  if (bu.p.y > 0.5) { dir = vec2f(1.0, 0.0); }
  let radius = ceil(sigma * 3.0);
  let step = max(1.0, radius / 32.0);
  var acc = vec4f(0.0);
  var wsum = 0.0;
  var i = -radius;
  loop {
    if (i > radius) { break; }
    let w = exp(-(i * i) / (2.0 * sigma * sigma));
    let uv = (in.pos.xy + dir * i) / size;
    acc = acc + textureSampleLevel(src, src_samp, uv, 0.0) * w;
    wsum = wsum + w;
    i = i + step;
  }
  return acc / wsum;
}

@fragment
fn fs_blit(in: FOut) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(src, 0));
  return textureSampleLevel(src, src_samp, in.pos.xy / size, 0.0);
}
