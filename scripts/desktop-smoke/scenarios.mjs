// Real published templates; each interaction names an observable UI response.
export const templateScenarios = [
  { id: 'bunny', title: 'Bunny', readyImage: 'src/mainview/assets/bunny.png', actions: [
    { move: [0.5, 0.5], expectChange: true },
    { move: [0.9, 0.9], expectChange: true },
  ] },
  { id: 'zig-wgpu', title: 'Zig WGPU', gpuRegion: [0.08, 0.25, 0.60, 0.85], readyText: 'Surface ready', actions: [
    { click: 'Toggle', expectText: 'Julia', expectChange: true },
    { clickAgain: true, expectText: 'Mandelbrot', expectChange: true },
  ] },
  { id: 'odin-fluid-wgpu', title: 'Neon Fluid Lab', gpuRegion: [0.08, 0.25, 0.85, 0.65], readyText: 'Odin solver online', actions: [
    { click: 'Pause', expectText: 'Resume', expectChange: true },
    { click: 'Resume', expectText: 'Pause', expectChange: true },
  ] },
  { id: 'rust-flock-wgpu', title: 'Rust Flock WGPU', gpuRegion: [0.08, 0.25, 0.60, 0.85], readyText: 'Surface ready', actions: [
    { move: [0.3, 0.5], expectCursor: true, expectChange: true },
    { move: [0.6, 0.7], expectCursor: true, expectChange: true },
  ] },
  { id: 'go-maze-wgpu', title: 'Go Maze WGPU', gpuRegion: [0.08, 0.25, 0.60, 0.85], readyText: 'Solved', actions: [
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
  { id: 'kitchen-native-ui', title: 'Native UI kitchen sink', minimizeWindow: 'Electrobun Integration Tests', test: 'Native GPU UI kitchen sink', readyText: 'Open dialog', actions: [
    { click: 'Clicked', expectChange: true },
    { click: 'Open dialog', expectText: 'Rendered in a Portal', expectChange: true },
    { click: 'Cancel', absentText: 'Rendered in a Portal', expectChange: true },
  ] },
];
