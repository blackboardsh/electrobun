import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const rendererPath = new URL('../templates/bunny/src/mainview/index.ts', import.meta.url);
const source = readFileSync(rendererPath, 'utf8');
const importedSource = source.replace(
  /^import Electrobun, \{ Electroview \} from ["']electrobun\/view["'];/m,
  'const { Electrobun, Electroview } = globalThis.__imports;',
);
assert.notEqual(importedSource, source, 'the renderer SDK import must be mocked, leaving application code intact');
const javascript = stripTypeScriptTypes(importedSource, { mode: 'strip', sourceUrl: rendererPath.href });

class Element {
  style = {};
  listeners = new Map();
  children = [];
  attributes = new Map();
  removed = false;
  constructor(tagName) { this.tagName = tagName; }
  cloneNode() { const node = new Element(this.tagName); node.style = { ...this.style }; return node; }
  setAttribute(key, value) { this.attributes.set(key, value); }
  appendChild(node) { this.children.push(node); node.parentNode = this; return node; }
  insertBefore(node, before) { this.children.splice(this.children.indexOf(before), 0, node); node.parentNode = this; }
  querySelector(selector) { return this.children.find(node => node.tagName === selector) ?? null; }
  getBoundingClientRect() { return { x: 0, y: 0, width: 180, height: 180 }; }
  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }
  removeEventListener(name, listener) {
    this.listeners.set(name, (this.listeners.get(name) ?? []).filter(value => value !== listener));
  }
  dispatch(name, properties = {}) {
    const event = { type: name, target: this, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, ...properties };
    for (const listener of this.listeners.get(name) ?? []) listener.call(this, event);
    return event;
  }
  remove() {
    this.removed = true;
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this);
  }
}

function launch(fault) {
  const bunny = new Element('div');
  const image = new Element('img');
  bunny.appendChild(image);
  const scene = new Element('div');
  const canvas = new Element('canvas');
  const frames = [];
  const observers = [];
  const state = { lost: fault === 'lost-context', draws: 0, drawCalls: 0, clears: 0, constructed: 0, clicks: 0, rpc: null, elapsed: 0, drawThrows: false, viewportThrows: false };
  const gl = {
    VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30, COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82, ARRAY_BUFFER: 0x8892, STATIC_DRAW: 0x88e4, FLOAT: 0x1406,
    BLEND: 0x0be2, ONE: 1, ONE_MINUS_SRC_ALPHA: 0x0303, COLOR_BUFFER_BIT: 0x4000,
    TRIANGLE_STRIP: 5, NO_ERROR: 0, CONTEXT_LOST_WEBGL: 0x9242,
    isContextLost() { return state.lost; },
    getError() { return state.lost ? this.CONTEXT_LOST_WEBGL : this.NO_ERROR; },
    createShader(type) {
      if ((fault === 'null-vertex-shader' && type === this.VERTEX_SHADER) ||
          (fault === 'null-fragment-shader' && type === this.FRAGMENT_SHADER)) return null;
      return { type };
    },
    shaderSource() {}, compileShader() {},
    getShaderParameter(shader, parameter) {
      assert.equal(parameter, this.COMPILE_STATUS);
      return shader !== null && !((fault === 'vertex-compile' && shader.type === this.VERTEX_SHADER) ||
        (fault === 'fragment-compile' && shader.type === this.FRAGMENT_SHADER));
    },
    getShaderInfoLog() { return 'test shader compilation failed'; },
    createProgram() { return fault === 'null-program' ? null : {}; },
    attachShader() {}, linkProgram() {},
    getProgramParameter(program, parameter) { assert.equal(parameter, this.LINK_STATUS); return program !== null && fault !== 'link'; },
    getProgramInfoLog() { return 'test program link failed'; },
    useProgram() {},
    createBuffer() { return fault === 'null-buffer' ? null : {}; },
    bindBuffer() {},
    bufferData() { if (fault === 'setup-exception') throw new Error('WebGL buffer initialization failed'); },
    getAttribLocation() { return fault === 'missing-attribute' ? -1 : 0; },
    enableVertexAttribArray() {}, vertexAttribPointer() {},
    getUniformLocation(_program, name) { return fault === 'missing-uniform' ? null : { name }; },
    enable() {}, blendFunc() {},
    viewport() { if (state.viewportThrows) throw new Error('WebGL viewport failed'); },
    uniform1f() {}, uniform2f() {},
    clear() { state.clears++; },
    drawArrays(mode, offset, count) {
      state.drawCalls++;
      if (state.drawThrows) throw new Error('WebGL draw failed');
      if (state.lost) return;
      assert.equal(mode, this.TRIANGLE_STRIP);
      assert.equal(offset, 0);
      assert.equal(count, 4);
      state.draws++;
    },
    deleteShader() {}, deleteProgram() {}, deleteBuffer() {},
  };
  canvas.getContext = function(type) {
    assert.equal(type, 'webgl');
    if (fault === 'context-exception') throw new Error('WebGL context creation failed');
    return fault === 'null-context' ? null : gl;
  };
  class Electroview {
    static defineRPC(config) {
      state.rpc = config;
      return { send: { bunnyClicked() { state.clicks++; } } };
    }
    constructor() { state.constructed++; }
  }
  const deterministicMath = Object.create(Math);
  deterministicMath.random = () => 0.5;
  const browser = {
    __imports: { Electrobun: { Electroview }, Electroview },
    document: {
      getElementById(id) { return id === 'bunny' ? bunny : id === 'scene' ? scene : null; },
      createElement(tag) { assert.equal(tag, 'canvas'); return canvas; },
    },
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
      observe(target) { this.target = target; }
      disconnect() { this.disconnected = true; }
    },
    devicePixelRatio: 2,
    performance: { now: () => state.elapsed },
    Math: deterministicMath,
    requestAnimationFrame(callback) { frames.push(callback); return frames.length; },
    cancelAnimationFrame() {},
    console: { log() {}, warn() {}, error() {} },
  };
  browser.window = browser;
  vm.runInNewContext(javascript, browser, { timeout: 1000, filename: rendererPath.pathname });
  return { bunny, scene, canvas, state, gl, observers,
    step() {
      assert.equal(frames.length, 1, 'exactly one animation frame should remain scheduled');
      state.elapsed += 16;
      frames.shift()(state.elapsed);
      assert.equal(frames.length, 1, 'the next frame must remain scheduled after rendering');
    },
    move(screenX, screenY) {
      state.rpc.handlers.messages.cursorMove({ screenX, screenY, winX: 0, winY: 0, winW: 200, winH: 200 });
    },
  };
}

function assertInteraction(app) {
  assert.equal(app.state.constructed, 1, 'the original Electroview must initialize');
  assert.equal(typeof app.state.rpc?.handlers.messages.cursorMove, 'function');
  assert.equal(app.bunny.children.filter(child => child.tagName === 'img').length, 13, 'the original depth layers remain');
  const initial = app.bunny.style.transform;
  app.move(190, 20);
  app.step();
  const moved = app.bunny.style.transform;
  assert.notEqual(moved, initial, 'cursor RPC must change CSS rotation');
  for (let index = 0; index < 5; index++) app.step();
  assert.notEqual(app.bunny.style.transform, moved, 'spring animation must continue over subsequent frames');
  const beforeReverse = app.bunny.style.transform;
  app.move(10, 180);
  app.step();
  assert.notEqual(app.bunny.style.transform, beforeReverse, 'later cursor messages must still animate');
  app.scene.dispatch('mousedown', { screenX: 20, screenY: 20 });
  app.scene.dispatch('mouseup', { screenX: 21, screenY: 20 });
  assert.equal(app.state.clicks, 1, 'the original click RPC remains connected');
  app.scene.dispatch('mousedown', { screenX: 20, screenY: 20 });
  app.scene.dispatch('mouseup', { screenX: 50, screenY: 20 });
  assert.equal(app.state.clicks, 1, 'dragging must not become a click');
}

for (const fault of [
  'null-context', 'lost-context', 'null-vertex-shader', 'null-fragment-shader',
  'null-program', 'null-buffer', 'vertex-compile', 'fragment-compile', 'link',
  'missing-attribute', 'missing-uniform', 'context-exception', 'setup-exception',
]) {
  test(`Bunny RPC and CSS animation survive ${fault}`, () => {
    const app = launch(fault);
    assertInteraction(app);
    assert.equal(app.state.drawCalls, 0, 'a failed optional spark effect must not attempt draws');
    assert.ok(app.canvas.removed || app.canvas.hidden || app.canvas.style.display === 'none', 'the unavailable spark canvas must be hidden');
  });
}

test('Bunny retains WebGL sparks and cursor animation when the GPU works', () => {
  const app = launch();
  assertInteraction(app);
  assert.ok(app.state.draws >= 8, 'healthy WebGL must continue drawing sparks each frame');
  assert.equal(app.canvas.width, 360);
  assert.equal(app.canvas.height, 360);
  assert.notEqual(app.canvas.style.display, 'none');
});

for (const dispatchEvent of [true, false]) {
  test(`Bunny keeps animating after WebGL context loss ${dispatchEvent ? 'with' : 'without'} a DOM event`, () => {
    const app = launch();
    app.step();
    assert.ok(app.state.draws > 0);
    const drawCalls = app.state.drawCalls;
    app.state.lost = true;
    if (dispatchEvent) app.canvas.dispatch('webglcontextlost');
    assertInteraction(app);
    assert.equal(app.state.drawCalls, drawCalls, 'no new spark draws are allowed after context loss');
    assert.ok(app.canvas.removed || app.canvas.hidden || app.canvas.style.display === 'none');
    for (const observer of app.observers) {
      // A callback already queued before disconnect must also remain safe.
      assert.doesNotThrow(() => observer.callback());
    }
  });
}

test('Bunny keeps animating when a later resize encounters a WebGL exception', () => {
  const app = launch();
  const drawCalls = app.state.drawCalls;
  assert.ok(app.observers.length > 0, 'healthy sparks must respond to canvas resizing');
  app.state.viewportThrows = true;
  for (const observer of app.observers) observer.callback();
  assertInteraction(app);
  assert.equal(app.state.drawCalls, drawCalls);
  assert.ok(app.canvas.removed || app.canvas.hidden || app.canvas.style.display === 'none');
});

test('Bunny keeps animating when WebGL drawing throws after initialization', () => {
  const app = launch();
  const draws = app.state.draws;
  const drawCalls = app.state.drawCalls;
  app.state.drawThrows = true;
  assertInteraction(app);
  assert.equal(app.state.draws, draws);
  assert.equal(app.state.drawCalls, drawCalls + 1, 'a failed draw must disable subsequent GPU attempts');
  assert.ok(app.canvas.removed || app.canvas.hidden || app.canvas.style.display === 'none');
});
