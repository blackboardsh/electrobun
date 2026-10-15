// Real published templates; each interaction names an observable UI response.
export const templateScenarios = [
  { id: 'bunny', title: 'Bunny', actions: [
    { move: [0.5, 0.5], expectChange: true },
    { move: [0.9, 0.9], expectChange: true },
  ] },
  { id: 'zig-wgpu', title: 'Zig WGPU', readyText: 'Surface ready', actions: [
    { click: 'Toggle', expectText: 'Julia', expectChange: true },
    { clickAgain: true, expectText: 'Mandelbrot', expectChange: true },
  ] },
  { id: 'odin-particles-wgpu', title: 'Odin Particles', readyText: 'Pause', actions: [
    { click: 'Pause', expectText: 'Resume', expectChange: true },
    { click: 'Resume', expectText: 'Pause', expectChange: true },
  ] },
  { id: 'rust-flock-wgpu', title: 'Rust Flock WGPU', readyText: 'Surface ready', actions: [
    { move: [0.3, 0.5], expectCursor: true, expectChange: true },
    { move: [0.6, 0.7], expectCursor: true, expectChange: true },
  ] },
  { id: 'go-maze-wgpu', title: 'Go Maze WGPU', readyText: 'Solved', actions: [
    { click: 'Generate', occurrence: 'last', expectText: 'Solved', expectChange: true },
  ] },
  { id: 'ui-wgpu', title: 'Electrobun UI', readyText: 'Reset', actions: [
    { click: '+ 1', aliases: ['+ i', '+ l'], expectCounter: 'incremented', expectChange: true },
    { click: 'Reset', expectCounter: 'reset', expectChange: true },
  ] },
];

export function skipReason(scenario, platform) {
  return platform === 'windows-arm64' && scenario.id.startsWith('odin-')
    ? 'The published Odin toolchain does not support Windows ARM64.' : null;
}

export const kitchenScenarios = [
  { id: 'kitchen-oopif-masks', title: 'Webview Tag Playground', test: 'Webview Tag playground', readyText: 'Search Target A', initialScrollHost: -1, scrollReadyText: 'Mask & Passthrough Controls', actions: [
    { click: 'Add Mask Selector', expectText: 'Mask Overlay 2', expectChange: true },
    { doubleClick: 'Mask Overlay 2' },
    { scrollHost: -2, hostAnchor: 'Mask & Passthrough Controls', childAnchor: 'Search Target A', expectChange: true },
    { scrollHost: 2, hostAnchor: 'Mask & Passthrough Controls', childAnchor: 'Search Target A', expectChange: true },
    { click: 'Remove Mask Selector', absentText: 'Mask Overlay 2', expectChange: true },
  ] },
  { id: 'kitchen-cottontail-ui', title: 'Electrobun UI (kitchen)', minimizeWindow: 'Electrobun Integration Tests', test: 'Electrobun UI demo window', readyText: 'reactive GPU chrome', actions: [
    { click: '+ 1', aliases: ['+ i', '+ l'], expectCounter: 'incremented', expectChange: true },
    { click: 'Reset', expectCounter: 'reset', expectChange: true },
  ] },
];
