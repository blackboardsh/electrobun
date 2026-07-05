package main

/*
#include <stdint.h>
#include <stdlib.h>

typedef void* (*wgpuDeviceCreateShaderModuleFn)(void*, void*);
typedef void* (*wgpuDeviceCreateRenderPipelineFn)(void*, void*);
typedef void* (*wgpuDeviceCreateBufferFn)(void*, void*);
typedef void* (*wgpuDeviceCreateCommandEncoderFn)(void*, void*);
typedef void* (*wgpuTextureCreateViewFn)(void*, void*);
typedef void* (*wgpuCommandEncoderBeginRenderPassFn)(void*, void*);
typedef void (*wgpuRenderPassEncoderSetPipelineFn)(void*, void*);
typedef void (*wgpuRenderPassEncoderSetVertexBufferFn)(void*, uint32_t, void*, uint64_t, uint64_t);
typedef void (*wgpuRenderPassEncoderDrawFn)(void*, uint32_t, uint32_t, uint32_t, uint32_t);
typedef void (*wgpuRenderPassEncoderEndFn)(void*);
typedef void* (*wgpuCommandEncoderFinishFn)(void*, void*);
typedef void (*wgpuQueueWriteBufferFn)(void*, void*, uint64_t, const void*, uint64_t);
typedef void (*wgpuQueueSubmitFn)(void*, uint64_t, const void*);
typedef void (*wgpuInstanceProcessEventsFn)(void*);
typedef void (*wgpuReleaseFn)(void*);

static void* go_wgpuDeviceCreateShaderModule(void* fn, void* device, void* desc) {
	return ((wgpuDeviceCreateShaderModuleFn)fn)(device, desc);
}
static void* go_wgpuDeviceCreateRenderPipeline(void* fn, void* device, void* desc) {
	return ((wgpuDeviceCreateRenderPipelineFn)fn)(device, desc);
}
static void* go_wgpuDeviceCreateBuffer(void* fn, void* device, void* desc) {
	return ((wgpuDeviceCreateBufferFn)fn)(device, desc);
}
static void* go_wgpuDeviceCreateCommandEncoder(void* fn, void* device, void* desc) {
	return ((wgpuDeviceCreateCommandEncoderFn)fn)(device, desc);
}
static void* go_wgpuTextureCreateView(void* fn, void* texture, void* desc) {
	return ((wgpuTextureCreateViewFn)fn)(texture, desc);
}
static void* go_wgpuCommandEncoderBeginRenderPass(void* fn, void* encoder, void* desc) {
	return ((wgpuCommandEncoderBeginRenderPassFn)fn)(encoder, desc);
}
static void go_wgpuRenderPassEncoderSetPipeline(void* fn, void* pass, void* pipeline) {
	((wgpuRenderPassEncoderSetPipelineFn)fn)(pass, pipeline);
}
static void go_wgpuRenderPassEncoderSetVertexBuffer(void* fn, void* pass, uint32_t slot, void* buffer, uint64_t offset, uint64_t size) {
	((wgpuRenderPassEncoderSetVertexBufferFn)fn)(pass, slot, buffer, offset, size);
}
static void go_wgpuRenderPassEncoderDraw(void* fn, void* pass, uint32_t vertex_count, uint32_t instance_count, uint32_t first_vertex, uint32_t first_instance) {
	((wgpuRenderPassEncoderDrawFn)fn)(pass, vertex_count, instance_count, first_vertex, first_instance);
}
static void go_wgpuRenderPassEncoderEnd(void* fn, void* pass) {
	((wgpuRenderPassEncoderEndFn)fn)(pass);
}
static void* go_wgpuCommandEncoderFinish(void* fn, void* encoder, void* desc) {
	return ((wgpuCommandEncoderFinishFn)fn)(encoder, desc);
}
static void go_wgpuQueueWriteBuffer(void* fn, void* queue, void* buffer, uint64_t offset, const void* data, uint64_t size) {
	((wgpuQueueWriteBufferFn)fn)(queue, buffer, offset, data, size);
}
static void go_wgpuQueueSubmit(void* fn, void* queue, uint64_t count, const void* commands) {
	((wgpuQueueSubmitFn)fn)(queue, count, commands);
}
static void go_wgpuInstanceProcessEvents(void* fn, void* instance) {
	((wgpuInstanceProcessEventsFn)fn)(instance);
}
static void go_wgpuRelease(void* fn, void* value) {
	((wgpuReleaseFn)fn)(value);
}
*/
import "C"

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"electrobun"
)

const (
	defaultSecretKey = "1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32"

	maxMazeColumns = 84
	maxMazeRows    = 52
	maxTileWidth   = maxMazeColumns*2 + 1
	maxTileHeight  = maxMazeRows*2 + 1
	maxTileCount   = maxTileWidth * maxTileHeight

	verticesPerQuad  = 6
	floatsPerVertex  = 6
	vertexStride     = uint64(floatsPerVertex * 4)
	vertexBufferSize = uint64(maxTileCount * verticesPerQuad * floatsPerVertex * 4)
	surfaceFormat    = uint32(0x0000001c)

	targetFrameTime    = 16 * time.Millisecond
	defaultWindowWidth = 1120.0
	defaultWindowH     = 740.0
)

const mazeShader = `
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
`

const (
	tileWall byte = iota
	tilePassage
	tileStack
	tileCurrent
	tileOpen
	tileClosed
	tilePath
	tileStart
	tileEnd
)

type appState struct {
	core        *electrobun.Core
	bundlePaths electrobun.BundlePaths
	commands    chan mazeCommand
	snapshot    atomic.Value
}

type mazeConfig struct {
	Columns       int `json:"columns"`
	Rows          int `json:"rows"`
	GenerateSpeed int `json:"generateSpeed"`
	SolveSpeed    int `json:"solveSpeed"`
	Shortcuts     int `json:"shortcuts"`
}

type mazeRequest struct {
	ID     uint32          `json:"id"`
	Rect   electrobun.Rect `json:"rect"`
	Config mazeConfig      `json:"config"`
}

type rpcPacket struct {
	Type   string          `json:"type"`
	ID     uint64          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type mazeCommand struct {
	Kind          string
	ViewID        uint32
	HostWebviewID uint32
	SurfaceWidth  uint32
	SurfaceHeight uint32
	Config        mazeConfig
}

type mazeSnapshot struct {
	ViewID        uint32
	HostWebviewID uint32
	SurfaceWidth  uint32
	SurfaceHeight uint32
	Columns       int
	Rows          int
	TileWidth     int
	TileHeight    int
	Cells         int
	Visited       int
	Frontier      int
	Path          int
	Status        string
	Tiles         []byte
}

type mazeEngine struct {
	config        mazeConfig
	viewID        uint32
	hostWebviewID uint32
	surfaceWidth  uint32
	surfaceHeight uint32

	tileWidth  int
	tileHeight int
	carved     []bool
	visited    []bool
	stack      []int
	current    int
	generated  int

	shortcutRemaining int
	generationDone    bool

	openSet       []bool
	closed        []bool
	solving       bool
	solved        bool
	path          []int
	solveSteps    int
	solverUpdates chan solverUpdate
	solverCancel  chan struct{}

	rng lcg
}

type lcg struct {
	state uint64
}

type solverUpdate struct {
	openSet []bool
	closed  []bool
	path    []int
	steps   int
	done    bool
	solved  bool
}

type parallelSolver struct {
	config  mazeConfig
	carved  []bool
	updates chan<- solverUpdate
	cancel  <-chan struct{}

	mu          sync.Mutex
	visitedBy   []byte
	parentStart []int
	parentEnd   []int
	openSet     []bool
	closed      []bool
	steps       int
	done        bool
	solved      bool
	path        []int
}

type wgpuAPI struct {
	deviceCreateShaderModule       unsafe.Pointer
	deviceCreateRenderPipeline     unsafe.Pointer
	deviceCreateBuffer             unsafe.Pointer
	deviceCreateCommandEncoder     unsafe.Pointer
	textureCreateView              unsafe.Pointer
	commandEncoderBeginRenderPass  unsafe.Pointer
	renderPassEncoderSetPipeline   unsafe.Pointer
	renderPassEncoderSetVertexBuff unsafe.Pointer
	renderPassEncoderDraw          unsafe.Pointer
	renderPassEncoderEnd           unsafe.Pointer
	commandEncoderFinish           unsafe.Pointer
	queueWriteBuffer               unsafe.Pointer
	queueSubmit                    unsafe.Pointer
	instanceProcessEvents          unsafe.Pointer
	textureRelease                 unsafe.Pointer
	textureViewRelease             unsafe.Pointer
	commandBufferRelease           unsafe.Pointer
	commandEncoderRelease          unsafe.Pointer
}

type gpuPipeline struct {
	pipeline     unsafe.Pointer
	vertexBuffer unsafe.Pointer
}

var (
	state            *appState
	hostQueueRunning atomic.Bool
	shuttingDown     atomic.Bool
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "[go-maze-wgpu] %s\n", err)
		os.Exit(1)
	}
}

func run() error {
	core, err := electrobun.LoadCore()
	if err != nil {
		return err
	}
	bundlePaths, err := electrobun.ResolveBundlePaths()
	if err != nil {
		return err
	}
	appInfo, err := electrobun.ResolveAppInfoFromBundle(bundlePaths)
	if err != nil {
		return err
	}

	state = &appState{
		core:        core,
		bundlePaths: bundlePaths,
		commands:    make(chan mazeCommand, 16),
	}

	go createUI()
	shuttingDown.Store(false)
	hostQueueRunning.Store(true)

	hostQueueThreadDone := make(chan struct{})
	engineThreadDone := make(chan struct{})
	renderThreadDone := make(chan struct{})

	go func() {
		defer close(hostQueueThreadDone)
		drainHostMessageQueue()
	}()
	go func() {
		defer close(engineThreadDone)
		mazeEngineLoop()
	}()
	go func() {
		defer close(renderThreadDone)
		mazeRenderLoop()
	}()

	err = core.RunMainThread(appInfo)
	hostQueueRunning.Store(false)
	<-hostQueueThreadDone
	<-engineThreadDone
	<-renderThreadDone
	return err
}

func createUI() {
	time.Sleep(150 * time.Millisecond)
	if err := state.core.ConfigureWebviewRuntimeFromExecutableDir(state.bundlePaths, 0); err != nil {
		fmt.Fprintf(os.Stderr, "[go-maze-wgpu] failed to configure webview runtime: %s\n", err)
		return
	}

	windowOptions := electrobun.NewWindowOptions(
		"Go Maze WGPU",
		electrobun.NewRect(140, 100, defaultWindowWidth, defaultWindowH),
	)
	windowOptions.Callbacks = electrobun.WindowCallbacks{Close: mainWindowClosed}
	windowID, err := state.core.CreateWindow(windowOptions)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[go-maze-wgpu] failed to create window: %s\n", err)
		return
	}

	webviewOptions := electrobun.NewWebviewOptions(
		windowID,
		"views://mainview/index.html",
		electrobun.NewRect(0, 0, defaultWindowWidth, defaultWindowH),
	)
	webviewOptions.SecretKey = defaultSecretKey
	webviewOptions.Sandbox = false
	webviewOptions.Callbacks = electrobun.WebviewCallbacks{
		DecideNavigation: electrobun.AllowAllNavigation,
		Event:            electrobun.NoopWebviewEvent,
		EventBridge:      electrobun.NoopWebviewPostMessage,
		HostBridge:       hostBridge,
	}

	if _, err := state.core.CreateWebview(webviewOptions); err != nil {
		fmt.Fprintf(os.Stderr, "[go-maze-wgpu] failed to create webview: %s\n", err)
		_ = state.core.CloseWindow(windowID)
	}
}

func mainWindowClosed(uint32) {
	requestShutdown()
}

func requestShutdown() {
	if shuttingDown.Swap(true) {
		return
	}
	hostQueueRunning.Store(false)
	if state != nil {
		_ = state.core.StopEventLoop()
	}
}

func drainHostMessageQueue() {
	for hostQueueRunning.Load() {
		drainedAny := false
		for hostQueueRunning.Load() {
			webviewID, message, ok := state.core.PopNextQueuedHostMessageString()
			if !ok {
				break
			}
			handleHostMessage(webviewID, message)
			drainedAny = true
		}
		if !drainedAny {
			time.Sleep(10 * time.Millisecond)
		}
	}
}

func hostBridge(webviewID uint32, message string) {
	handleHostMessage(webviewID, message)
}

func handleHostMessage(webviewID uint32, message string) {
	var packet rpcPacket
	if json.Unmarshal([]byte(message), &packet) != nil || packet.Type != "request" {
		return
	}

	switch packet.Method {
	case "startMaze", "configureMaze", "regenerateMaze":
		var req mazeRequest
		if err := json.Unmarshal(packet.Params, &req); err != nil {
			sendRPCResponseError(webviewID, packet.ID, err.Error())
			return
		}
		kind := "configure"
		if packet.Method == "startMaze" || packet.Method == "regenerateMaze" {
			kind = "regenerate"
		}
		cmd := mazeCommand{
			Kind:          kind,
			ViewID:        req.ID,
			HostWebviewID: webviewID,
			SurfaceWidth:  uint32(math.Max(1, math.Round(req.Rect.Width))),
			SurfaceHeight: uint32(math.Max(1, math.Round(req.Rect.Height))),
			Config:        normalizeConfig(req.Config),
		}
		if err := sendCommand(cmd); err != nil {
			sendRPCResponseError(webviewID, packet.ID, err.Error())
			return
		}
		sendRPCResponseSuccess(webviewID, packet.ID, `{"ok":true}`)
	case "solveMaze":
		if err := sendCommand(mazeCommand{Kind: "solve"}); err != nil {
			sendRPCResponseError(webviewID, packet.ID, err.Error())
			return
		}
		sendRPCResponseSuccess(webviewID, packet.ID, `{"ok":true}`)
	default:
		sendRPCResponseError(webviewID, packet.ID, "Unknown RPC request")
	}
}

func sendCommand(cmd mazeCommand) error {
	select {
	case state.commands <- cmd:
		return nil
	case <-time.After(200 * time.Millisecond):
		return errors.New("maze engine did not accept command")
	}
}

func normalizeConfig(config mazeConfig) mazeConfig {
	config.Columns = clampInt(config.Columns, 20, maxMazeColumns)
	config.Rows = clampInt(config.Rows, 14, maxMazeRows)
	config.GenerateSpeed = clampInt(config.GenerateSpeed, 1, 1200)
	config.SolveSpeed = clampInt(config.SolveSpeed, 1, 1200)
	config.Shortcuts = clampInt(config.Shortcuts, 0, 80)
	return config
}

func defaultMazeConfig() mazeConfig {
	return mazeConfig{
		Columns:       62,
		Rows:          38,
		GenerateSpeed: 180,
		SolveSpeed:    240,
		Shortcuts:     18,
	}
}

func mazeEngineLoop() {
	engine := newMazeEngine(defaultMazeConfig(), 0, 0, 1, 1)
	ticker := time.NewTicker(targetFrameTime)
	defer engine.stopSolver()
	defer ticker.Stop()

	for hostQueueRunning.Load() {
		select {
		case cmd := <-state.commands:
			engine.applyCommand(cmd)
			state.snapshot.Store(engine.snapshot())
		case <-ticker.C:
			engine.tick()
			state.snapshot.Store(engine.snapshot())
		}
	}
}

func newMazeEngine(config mazeConfig, viewID, hostWebviewID, surfaceWidth, surfaceHeight uint32) *mazeEngine {
	config = normalizeConfig(config)
	engine := &mazeEngine{
		config:            config,
		viewID:            viewID,
		hostWebviewID:     hostWebviewID,
		surfaceWidth:      maxUint32(surfaceWidth, 1),
		surfaceHeight:     maxUint32(surfaceHeight, 1),
		tileWidth:         config.Columns*2 + 1,
		tileHeight:        config.Rows*2 + 1,
		shortcutRemaining: -1,
		current:           0,
		rng:               lcg{state: uint64(time.Now().UnixNano()) ^ 0x9e3779b97f4a7c15},
	}
	engine.carved = make([]bool, engine.tileWidth*engine.tileHeight)
	engine.visited = make([]bool, config.Columns*config.Rows)
	engine.visited[0] = true
	engine.generated = 1
	engine.stack = []int{0}
	engine.carveCell(0)
	return engine
}

func (e *mazeEngine) applyCommand(cmd mazeCommand) {
	switch cmd.Kind {
	case "regenerate":
		e.stopSolver()
		*e = *newMazeEngine(cmd.Config, cmd.ViewID, cmd.HostWebviewID, cmd.SurfaceWidth, cmd.SurfaceHeight)
	case "configure":
		cmd.Config = normalizeConfig(cmd.Config)
		dimensionsChanged := cmd.Config.Columns != e.config.Columns || cmd.Config.Rows != e.config.Rows || cmd.Config.Shortcuts != e.config.Shortcuts
		if dimensionsChanged {
			e.stopSolver()
			*e = *newMazeEngine(cmd.Config, cmd.ViewID, cmd.HostWebviewID, cmd.SurfaceWidth, cmd.SurfaceHeight)
			return
		}
		e.config = cmd.Config
		if cmd.ViewID != 0 {
			e.viewID = cmd.ViewID
		}
		if cmd.HostWebviewID != 0 {
			e.hostWebviewID = cmd.HostWebviewID
		}
		e.surfaceWidth = maxUint32(cmd.SurfaceWidth, 1)
		e.surfaceHeight = maxUint32(cmd.SurfaceHeight, 1)
	case "solve":
		if e.generationDone {
			e.startSolver()
		}
	}
}

func (e *mazeEngine) tick() {
	if !e.generationDone {
		for i := 0; i < e.config.GenerateSpeed && !e.generationDone; i++ {
			e.stepGeneration()
		}
		return
	}
	if e.solving {
		e.drainSolverUpdates()
	}
}

func (e *mazeEngine) stepGeneration() {
	if len(e.stack) > 0 {
		current := e.stack[len(e.stack)-1]
		e.current = current
		neighbors := e.unvisitedNeighbors(current)
		if len(neighbors) > 0 {
			next := neighbors[e.rng.nextInt(len(neighbors))]
			e.carveConnection(current, next)
			e.visited[next] = true
			e.generated++
			e.stack = append(e.stack, next)
			e.current = next
			return
		}
		e.stack = e.stack[:len(e.stack)-1]
		return
	}

	if e.shortcutRemaining < 0 {
		e.shortcutRemaining = e.config.Columns * e.config.Rows * e.config.Shortcuts / 420
	}
	if e.shortcutRemaining > 0 {
		e.stepShortcut()
		return
	}
	e.generationDone = true
	e.startSolver()
}

func (e *mazeEngine) stepShortcut() {
	cellCount := e.config.Columns * e.config.Rows
	for attempt := 0; attempt < 28; attempt++ {
		cell := e.rng.nextInt(cellCount)
		neighbors := e.unconnectedNeighbors(cell)
		if len(neighbors) == 0 {
			continue
		}
		e.carveConnection(cell, neighbors[e.rng.nextInt(len(neighbors))])
		e.shortcutRemaining--
		return
	}
	e.shortcutRemaining = 0
}

func (e *mazeEngine) startSolver() {
	e.stopSolver()
	cellCount := e.config.Columns * e.config.Rows
	e.openSet = make([]bool, cellCount)
	e.closed = make([]bool, cellCount)
	e.path = nil
	e.solveSteps = 0
	e.solved = false
	e.solving = true
	e.openSet[0] = true
	e.openSet[cellCount-1] = true
	e.solverUpdates = make(chan solverUpdate, 64)
	e.solverCancel = make(chan struct{})
	solver := newParallelSolver(e.config, e.carved, e.solverUpdates, e.solverCancel)
	go solver.run(e.config.SolveSpeed)
}

func (e *mazeEngine) stopSolver() {
	if e.solverCancel != nil {
		close(e.solverCancel)
		e.solverCancel = nil
	}
	e.solverUpdates = nil
	e.solving = false
}

func (e *mazeEngine) drainSolverUpdates() {
	for e.solverUpdates != nil {
		select {
		case update := <-e.solverUpdates:
			e.openSet = update.openSet
			e.closed = update.closed
			e.path = update.path
			e.solveSteps = update.steps
			if update.done {
				e.solving = false
				e.solved = update.solved
				e.solverUpdates = nil
			}
		default:
			return
		}
	}
}

func newParallelSolver(config mazeConfig, carved []bool, updates chan<- solverUpdate, cancel <-chan struct{}) *parallelSolver {
	cellCount := config.Columns * config.Rows
	parentStart := make([]int, cellCount)
	parentEnd := make([]int, cellCount)
	for i := 0; i < cellCount; i++ {
		parentStart[i] = -1
		parentEnd[i] = -1
	}
	visitedBy := make([]byte, cellCount)
	openSet := make([]bool, cellCount)
	start := 0
	end := cellCount - 1
	visitedBy[start] = 1
	visitedBy[end] = 2
	openSet[start] = true
	openSet[end] = true

	return &parallelSolver{
		config:      config,
		carved:      carved,
		updates:     updates,
		cancel:      cancel,
		visitedBy:   visitedBy,
		parentStart: parentStart,
		parentEnd:   parentEnd,
		openSet:     openSet,
		closed:      make([]bool, cellCount),
	}
}

func (s *parallelSolver) run(speed int) {
	var workers sync.WaitGroup
	workers.Add(2)
	go func() {
		defer workers.Done()
		s.searchFrom(1, 0, speed)
	}()
	go func() {
		defer workers.Done()
		s.searchFrom(2, s.config.Columns*s.config.Rows-1, speed)
	}()
	s.sendUpdate(false)
	workers.Wait()
	s.mu.Lock()
	if !s.done {
		s.done = true
	}
	final := s.makeUpdateLocked(true)
	s.mu.Unlock()
	s.sendFinalUpdate(final)
}

func (s *parallelSolver) searchFrom(side byte, start int, speed int) {
	queue := []int{start}
	delay := time.Second / time.Duration(clampInt(speed, 1, 1200))
	lastUpdate := time.Now()

	for len(queue) > 0 && !s.isDone() {
		select {
		case <-s.cancel:
			return
		default:
		}

		current := queue[0]
		queue = queue[1:]
		queue = append(queue, s.expand(side, current)...)

		if time.Since(lastUpdate) >= 33*time.Millisecond {
			s.sendUpdate(false)
			lastUpdate = time.Now()
		}
		if delay > 0 {
			select {
			case <-s.cancel:
				return
			case <-time.After(delay):
			}
		}
	}
}

func (s *parallelSolver) isDone() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.done
}

func (s *parallelSolver) expand(side byte, current int) []int {
	other := byte(1)
	if side == 1 {
		other = 2
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.done || s.closed[current] {
		return nil
	}

	s.openSet[current] = false
	s.closed[current] = true
	s.steps++
	nextCells := make([]int, 0, 3)

	for _, neighbor := range s.connectedNeighbors(current) {
		owner := s.visitedBy[neighbor]
		if owner == 0 {
			s.visitedBy[neighbor] = side
			if side == 1 {
				s.parentStart[neighbor] = current
			} else {
				s.parentEnd[neighbor] = current
			}
			s.openSet[neighbor] = true
			nextCells = append(nextCells, neighbor)
			continue
		}
		if owner == other {
			s.path = s.buildPathLocked(side, current, neighbor)
			s.solved = true
			s.done = true
			return nil
		}
	}

	return nextCells
}

func (s *parallelSolver) buildPathLocked(side byte, current, neighbor int) []int {
	if side == 1 {
		path := s.pathFromStartLocked(current)
		return append(path, s.pathFromEndLocked(neighbor)...)
	}
	path := s.pathFromStartLocked(neighbor)
	return append(path, s.pathFromEndLocked(current)...)
}

func (s *parallelSolver) pathFromStartLocked(cell int) []int {
	path := []int{}
	for cell >= 0 {
		path = append(path, cell)
		cell = s.parentStart[cell]
	}
	for left, right := 0, len(path)-1; left < right; left, right = left+1, right-1 {
		path[left], path[right] = path[right], path[left]
	}
	return path
}

func (s *parallelSolver) pathFromEndLocked(cell int) []int {
	path := []int{}
	for cell >= 0 {
		path = append(path, cell)
		cell = s.parentEnd[cell]
	}
	return path
}

func (s *parallelSolver) sendUpdate(done bool) {
	s.mu.Lock()
	update := s.makeUpdateLocked(done)
	s.mu.Unlock()
	select {
	case s.updates <- update:
	case <-s.cancel:
	default:
	}
}

func (s *parallelSolver) sendFinalUpdate(update solverUpdate) {
	select {
	case s.updates <- update:
	case <-s.cancel:
	}
}

func (s *parallelSolver) makeUpdateLocked(done bool) solverUpdate {
	return solverUpdate{
		openSet: append([]bool(nil), s.openSet...),
		closed:  append([]bool(nil), s.closed...),
		path:    append([]int(nil), s.path...),
		steps:   s.steps,
		done:    done,
		solved:  s.solved,
	}
}

func (s *parallelSolver) connectedNeighbors(cell int) []int {
	x, y := s.cellXY(cell)
	result := make([]int, 0, 4)
	if x > 0 {
		result = append(result, s.cellIndex(x-1, y))
	}
	if x < s.config.Columns-1 {
		result = append(result, s.cellIndex(x+1, y))
	}
	if y > 0 {
		result = append(result, s.cellIndex(x, y-1))
	}
	if y < s.config.Rows-1 {
		result = append(result, s.cellIndex(x, y+1))
	}
	filtered := result[:0]
	for _, neighbor := range result {
		if s.isConnected(cell, neighbor) {
			filtered = append(filtered, neighbor)
		}
	}
	return filtered
}

func (s *parallelSolver) isConnected(a, b int) bool {
	ax, ay := s.cellXY(a)
	bx, by := s.cellXY(b)
	return s.carved[s.tileIndex(ax+bx+1, ay+by+1)]
}

func (s *parallelSolver) cellXY(cell int) (int, int) {
	return cell % s.config.Columns, cell / s.config.Columns
}

func (s *parallelSolver) cellIndex(x, y int) int {
	return y*s.config.Columns + x
}

func (s *parallelSolver) tileIndex(x, y int) int {
	return y*(s.config.Columns*2+1) + x
}

func (e *mazeEngine) snapshot() mazeSnapshot {
	tiles := make([]byte, len(e.carved))
	for i, carved := range e.carved {
		if carved {
			tiles[i] = tilePassage
		}
	}

	if !e.generationDone {
		for _, cell := range e.stack {
			e.markCellTile(tiles, cell, tileStack)
		}
		if len(e.stack) > 0 {
			e.markCellTile(tiles, e.current, tileCurrent)
		}
	}

	frontier := 0
	if len(e.openSet) > 0 {
		for cell, isOpen := range e.openSet {
			if isOpen {
				frontier++
				e.markCellTile(tiles, cell, tileOpen)
			}
		}
	}
	if len(e.closed) > 0 {
		for cell, isClosed := range e.closed {
			if isClosed {
				e.markCellTile(tiles, cell, tileClosed)
			}
		}
	}
	if len(e.path) > 0 {
		for i, cell := range e.path {
			e.markCellTile(tiles, cell, tilePath)
			if i > 0 {
				e.markConnectorTile(tiles, e.path[i-1], cell, tilePath)
			}
		}
	}

	e.markCellTile(tiles, 0, tileStart)
	e.markCellTile(tiles, e.config.Columns*e.config.Rows-1, tileEnd)

	status := "Generating"
	if !e.generationDone && len(e.stack) == 0 && e.shortcutRemaining != 0 {
		status = "Adding shortcuts"
	}
	if e.generationDone {
		status = "Parallel solving"
	}
	if e.solved {
		status = "Solved"
	} else if e.generationDone && !e.solving {
		status = "Ready"
	}

	return mazeSnapshot{
		ViewID:        e.viewID,
		HostWebviewID: e.hostWebviewID,
		SurfaceWidth:  maxUint32(e.surfaceWidth, 1),
		SurfaceHeight: maxUint32(e.surfaceHeight, 1),
		Columns:       e.config.Columns,
		Rows:          e.config.Rows,
		TileWidth:     e.tileWidth,
		TileHeight:    e.tileHeight,
		Cells:         e.config.Columns * e.config.Rows,
		Visited:       e.generated,
		Frontier:      frontier,
		Path:          len(e.path),
		Status:        status,
		Tiles:         tiles,
	}
}

func (e *mazeEngine) unvisitedNeighbors(cell int) []int {
	result := make([]int, 0, 4)
	for _, neighbor := range e.neighbors(cell) {
		if !e.visited[neighbor] {
			result = append(result, neighbor)
		}
	}
	return result
}

func (e *mazeEngine) unconnectedNeighbors(cell int) []int {
	result := make([]int, 0, 4)
	for _, neighbor := range e.neighbors(cell) {
		if !e.isConnected(cell, neighbor) {
			result = append(result, neighbor)
		}
	}
	return result
}

func (e *mazeEngine) connectedNeighbors(cell int) []int {
	result := make([]int, 0, 4)
	for _, neighbor := range e.neighbors(cell) {
		if e.isConnected(cell, neighbor) {
			result = append(result, neighbor)
		}
	}
	return result
}

func (e *mazeEngine) neighbors(cell int) []int {
	x, y := e.cellXY(cell)
	result := make([]int, 0, 4)
	if x > 0 {
		result = append(result, e.cellIndex(x-1, y))
	}
	if x < e.config.Columns-1 {
		result = append(result, e.cellIndex(x+1, y))
	}
	if y > 0 {
		result = append(result, e.cellIndex(x, y-1))
	}
	if y < e.config.Rows-1 {
		result = append(result, e.cellIndex(x, y+1))
	}
	e.rng.shuffle(result)
	return result
}

func (e *mazeEngine) carveCell(cell int) {
	x, y := e.cellXY(cell)
	e.carved[e.tileIndex(x*2+1, y*2+1)] = true
}

func (e *mazeEngine) carveConnection(a, b int) {
	e.carveCell(a)
	e.carveCell(b)
	ax, ay := e.cellXY(a)
	bx, by := e.cellXY(b)
	e.carved[e.tileIndex(ax+bx+1, ay+by+1)] = true
}

func (e *mazeEngine) isConnected(a, b int) bool {
	ax, ay := e.cellXY(a)
	bx, by := e.cellXY(b)
	return e.carved[e.tileIndex(ax+bx+1, ay+by+1)]
}

func (e *mazeEngine) markCellTile(tiles []byte, cell int, kind byte) {
	x, y := e.cellXY(cell)
	tiles[e.tileIndex(x*2+1, y*2+1)] = kind
}

func (e *mazeEngine) markConnectorTile(tiles []byte, a, b int, kind byte) {
	ax, ay := e.cellXY(a)
	bx, by := e.cellXY(b)
	tiles[e.tileIndex(ax+bx+1, ay+by+1)] = kind
}

func (e *mazeEngine) cellXY(cell int) (int, int) {
	return cell % e.config.Columns, cell / e.config.Columns
}

func (e *mazeEngine) cellIndex(x, y int) int {
	return y*e.config.Columns + x
}

func (e *mazeEngine) tileIndex(x, y int) int {
	return y*e.tileWidth + x
}

func (r *lcg) nextUint32() uint32 {
	r.state = r.state*6364136223846793005 + 1442695040888963407
	return uint32(r.state >> 32)
}

func (r *lcg) nextInt(max int) int {
	if max <= 1 {
		return 0
	}
	return int(r.nextUint32() % uint32(max))
}

func (r *lcg) shuffle(values []int) {
	for i := len(values) - 1; i > 0; i-- {
		j := r.nextInt(i + 1)
		values[i], values[j] = values[j], values[i]
	}
}

func currentSnapshot() (mazeSnapshot, bool) {
	value := state.snapshot.Load()
	if value == nil {
		return mazeSnapshot{}, false
	}
	snapshot, ok := value.(mazeSnapshot)
	return snapshot, ok
}

func mazeRenderLoop() {
	native, err := electrobun.LoadWgpuNative()
	if err != nil {
		fmt.Fprintf(os.Stderr, "[go-maze-wgpu] failed to load WGPU library: %s\n", err)
		return
	}
	api, err := loadWgpuAPI(native)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[go-maze-wgpu] failed to load WGPU symbols: %s\n", err)
		return
	}

	vertices := make([]float32, 0, maxTileCount*verticesPerQuad*floatsPerVertex)
	var activeViewID uint32
	var context electrobun.WgpuContext
	var pipeline gpuPipeline
	var queue unsafe.Pointer
	var hasContext bool
	var configuredWidth uint32
	var configuredHeight uint32
	var frame uint64
	var statFrames int
	lastStat := time.Now()
	lastFPS := 0.0

	for hostQueueRunning.Load() {
		snapshot, ok := currentSnapshot()
		if !ok || snapshot.ViewID == 0 {
			time.Sleep(targetFrameTime)
			continue
		}

		if !hasContext || activeViewID != snapshot.ViewID {
			context, err = electrobun.CreateWgpuContextForWGPUView(state.core, native, snapshot.ViewID)
			if err != nil {
				fmt.Fprintf(os.Stderr, "[go-maze-wgpu] failed to create WGPU context: %s\n", err)
				time.Sleep(250 * time.Millisecond)
				continue
			}
			queue, err = context.GetQueue(native)
			if err != nil {
				fmt.Fprintf(os.Stderr, "[go-maze-wgpu] failed to get WGPU queue: %s\n", err)
				time.Sleep(250 * time.Millisecond)
				continue
			}
			pipeline, err = createMazePipeline(api, context)
			if err != nil {
				fmt.Fprintf(os.Stderr, "[go-maze-wgpu] failed to create WGPU pipeline: %s\n", err)
				time.Sleep(250 * time.Millisecond)
				continue
			}
			activeViewID = snapshot.ViewID
			configuredWidth = 0
			configuredHeight = 0
			hasContext = true
			fmt.Fprintf(os.Stderr, "[go-maze-wgpu] WGPU context ready for view %d\n", snapshot.ViewID)
		}

		if configuredWidth != snapshot.SurfaceWidth || configuredHeight != snapshot.SurfaceHeight {
			if err := configureSurface(state.core, context, snapshot.SurfaceWidth, snapshot.SurfaceHeight); err != nil {
				fmt.Fprintf(os.Stderr, "[go-maze-wgpu] failed to configure surface: %s\n", err)
				time.Sleep(250 * time.Millisecond)
				continue
			}
			configuredWidth = snapshot.SurfaceWidth
			configuredHeight = snapshot.SurfaceHeight
		}

		writeMazeVertices(snapshot, &vertices)
		if err := renderFrame(state.core, api, context, pipeline, queue, vertices); err != nil {
			fmt.Fprintf(os.Stderr, "[go-maze-wgpu] failed to render frame: %s\n", err)
			time.Sleep(100 * time.Millisecond)
			continue
		}

		frame++
		statFrames++
		elapsed := time.Since(lastStat)
		if elapsed >= 500*time.Millisecond {
			lastFPS = float64(statFrames) / elapsed.Seconds()
			statFrames = 0
			lastStat = time.Now()
		}
		if frame%20 == 0 {
			sendMazeFrame(snapshot, lastFPS)
		}
		time.Sleep(targetFrameTime)
	}
}

func writeMazeVertices(snapshot mazeSnapshot, out *[]float32) {
	*out = (*out)[:0]
	if len(snapshot.Tiles) == 0 || snapshot.TileWidth == 0 || snapshot.TileHeight == 0 {
		return
	}
	for y := 0; y < snapshot.TileHeight; y++ {
		for x := 0; x < snapshot.TileWidth; x++ {
			kind := snapshot.Tiles[y*snapshot.TileWidth+x]
			if kind == tileWall {
				continue
			}
			r, g, b := tileColor(kind)
			x0 := float32(x)/float32(snapshot.TileWidth)*2 - 1
			x1 := float32(x+1)/float32(snapshot.TileWidth)*2 - 1
			y0 := 1 - float32(y)/float32(snapshot.TileHeight)*2
			y1 := 1 - float32(y+1)/float32(snapshot.TileHeight)*2
			pushQuad(out, x0, y0, x1, y1, r, g, b)
		}
	}
}

func tileColor(kind byte) (float32, float32, float32) {
	switch kind {
	case tileStart:
		return 0.30, 0.95, 0.58
	case tileEnd:
		return 1.00, 0.32, 0.44
	case tilePath:
		return 0.88, 0.98, 1.00
	case tileClosed:
		return 0.16, 0.38, 0.86
	case tileOpen:
		return 0.98, 0.76, 0.24
	case tileCurrent:
		return 0.28, 0.95, 0.80
	case tileStack:
		return 0.25, 0.58, 0.64
	default:
		return 0.10, 0.18, 0.24
	}
}

func pushQuad(out *[]float32, x0, y0, x1, y1, r, g, b float32) {
	pushVertex(out, x0, y0, r, g, b)
	pushVertex(out, x1, y0, r, g, b)
	pushVertex(out, x1, y1, r, g, b)
	pushVertex(out, x0, y0, r, g, b)
	pushVertex(out, x1, y1, r, g, b)
	pushVertex(out, x0, y1, r, g, b)
}

func pushVertex(out *[]float32, x, y, r, g, b float32) {
	*out = append(*out, x, y, r, g, b, 1)
}

func loadWgpuAPI(native *electrobun.WgpuNative) (wgpuAPI, error) {
	get := func(name string) (unsafe.Pointer, error) {
		symbol, ok := native.Symbol(name)
		if !ok {
			return nil, fmt.Errorf("missing WGPU symbol %s", name)
		}
		return symbol, nil
	}

	var api wgpuAPI
	var err error
	api.deviceCreateShaderModule, err = get("wgpuDeviceCreateShaderModule")
	if err != nil {
		return api, err
	}
	api.deviceCreateRenderPipeline, err = get("wgpuDeviceCreateRenderPipeline")
	if err != nil {
		return api, err
	}
	api.deviceCreateBuffer, err = get("wgpuDeviceCreateBuffer")
	if err != nil {
		return api, err
	}
	api.deviceCreateCommandEncoder, err = get("wgpuDeviceCreateCommandEncoder")
	if err != nil {
		return api, err
	}
	api.textureCreateView, err = get("wgpuTextureCreateView")
	if err != nil {
		return api, err
	}
	api.commandEncoderBeginRenderPass, err = get("wgpuCommandEncoderBeginRenderPass")
	if err != nil {
		return api, err
	}
	api.renderPassEncoderSetPipeline, err = get("wgpuRenderPassEncoderSetPipeline")
	if err != nil {
		return api, err
	}
	api.renderPassEncoderSetVertexBuff, err = get("wgpuRenderPassEncoderSetVertexBuffer")
	if err != nil {
		return api, err
	}
	api.renderPassEncoderDraw, err = get("wgpuRenderPassEncoderDraw")
	if err != nil {
		return api, err
	}
	api.renderPassEncoderEnd, err = get("wgpuRenderPassEncoderEnd")
	if err != nil {
		return api, err
	}
	api.commandEncoderFinish, err = get("wgpuCommandEncoderFinish")
	if err != nil {
		return api, err
	}
	api.queueWriteBuffer, err = get("wgpuQueueWriteBuffer")
	if err != nil {
		return api, err
	}
	api.queueSubmit, err = get("wgpuQueueSubmit")
	if err != nil {
		return api, err
	}
	api.instanceProcessEvents, err = get("wgpuInstanceProcessEvents")
	if err != nil {
		return api, err
	}
	api.textureRelease, err = get("wgpuTextureRelease")
	if err != nil {
		return api, err
	}
	api.textureViewRelease, err = get("wgpuTextureViewRelease")
	if err != nil {
		return api, err
	}
	api.commandBufferRelease, err = get("wgpuCommandBufferRelease")
	if err != nil {
		return api, err
	}
	api.commandEncoderRelease, err = get("wgpuCommandEncoderRelease")
	return api, err
}

func configureSurface(core *electrobun.Core, context electrobun.WgpuContext, width, height uint32) error {
	const (
		wgpuTextureUsageRenderAttachment = uint64(0x0000000000000010)
		wgpuCompositeAlphaModeOpaque     = uint32(0x00000001)
		wgpuPresentModeFIFO              = uint32(0x00000001)
	)

	config := make([]byte, 64)
	writePtr(config, 0, nil)
	writePtr(config, 8, context.Device)
	writeU32(config, 16, surfaceFormat)
	writeU32(config, 20, 0)
	writeU64(config, 24, wgpuTextureUsageRenderAttachment)
	writeU32(config, 32, width)
	writeU32(config, 36, height)
	writeU64(config, 40, 0)
	writePtr(config, 48, nil)
	writeU32(config, 56, wgpuCompositeAlphaModeOpaque)
	writeU32(config, 60, wgpuPresentModeFIFO)
	return core.WgpuSurfaceConfigureMainThread(context.Surface, ptrFromBytes(config))
}

func createMazePipeline(api wgpuAPI, context electrobun.WgpuContext) (gpuPipeline, error) {
	const (
		wgpuVertexFormatFloat32x2 = uint32(0x0000001d)
		wgpuVertexFormatFloat32x4 = uint32(0x0000001f)
	)

	shaderCode := C.CString(mazeShader)
	defer C.free(unsafe.Pointer(shaderCode))
	vsEntry := C.CString("vs_main")
	defer C.free(unsafe.Pointer(vsEntry))
	fsEntry := C.CString("fs_main")
	defer C.free(unsafe.Pointer(fsEntry))

	shaderSource := makeShaderSourceWGSL(unsafe.Pointer(shaderCode))
	shaderDescriptor := makeShaderModuleDescriptor(ptrFromBytes(shaderSource))
	shaderModule := C.go_wgpuDeviceCreateShaderModule(api.deviceCreateShaderModule, context.Device, ptrFromBytes(shaderDescriptor))
	if shaderModule == nil {
		return gpuPipeline{}, errors.New("missing shader module")
	}

	attributes := make([]byte, 64)
	writeVertexAttribute(attributes, 0, 0, 0, wgpuVertexFormatFloat32x2)
	writeVertexAttribute(attributes, 1, 8, 1, wgpuVertexFormatFloat32x4)

	vertexLayout := makeVertexBufferLayout(ptrFromBytes(attributes), 2)
	vertexState := makeVertexState(shaderModule, unsafe.Pointer(vsEntry), ptrFromBytes(vertexLayout))
	colorTarget := makeColorTargetState(surfaceFormat)
	fragmentState := makeFragmentState(shaderModule, unsafe.Pointer(fsEntry), ptrFromBytes(colorTarget))
	primitiveState := makePrimitiveState()
	multisampleState := makeMultisampleState()
	pipelineDescriptor := makeRenderPipelineDescriptor(vertexState, primitiveState, multisampleState, ptrFromBytes(fragmentState))

	pipeline := C.go_wgpuDeviceCreateRenderPipeline(api.deviceCreateRenderPipeline, context.Device, ptrFromBytes(pipelineDescriptor))
	if pipeline == nil {
		return gpuPipeline{}, errors.New("missing render pipeline")
	}

	vertexBufferDescriptor := makeBufferDescriptor(vertexBufferSize)
	vertexBuffer := C.go_wgpuDeviceCreateBuffer(api.deviceCreateBuffer, context.Device, ptrFromBytes(vertexBufferDescriptor))
	if vertexBuffer == nil {
		return gpuPipeline{}, errors.New("missing vertex buffer")
	}

	return gpuPipeline{pipeline: pipeline, vertexBuffer: vertexBuffer}, nil
}

func renderFrame(core *electrobun.Core, api wgpuAPI, context electrobun.WgpuContext, pipeline gpuPipeline, queue unsafe.Pointer, vertices []float32) error {
	const (
		wgpuDepthSliceUndefined = uint32(0xffffffff)
		wgpuLoadOpClear         = uint32(0x00000002)
		wgpuStoreOpStore        = uint32(0x00000001)
	)

	C.go_wgpuInstanceProcessEvents(api.instanceProcessEvents, context.Instance)

	activeBytes := uint64(len(vertices) * 4)
	if activeBytes > 0 {
		C.go_wgpuQueueWriteBuffer(
			api.queueWriteBuffer,
			queue,
			pipeline.vertexBuffer,
			C.uint64_t(0),
			unsafe.Pointer(&vertices[0]),
			C.uint64_t(activeBytes),
		)
	}

	surfaceTexture := make([]byte, 24)
	if err := core.WgpuSurfaceGetCurrentTextureMainThread(context.Surface, ptrFromBytes(surfaceTexture)); err != nil {
		return err
	}
	texturePtr := unsafe.Pointer(uintptr(readU64(surfaceTexture, 8)))
	status := readU32(surfaceTexture, 16)
	if status != 1 && status != 2 {
		return errors.New("surface texture unavailable")
	}
	if texturePtr == nil {
		return errors.New("missing surface texture")
	}

	textureView := C.go_wgpuTextureCreateView(api.textureCreateView, texturePtr, nil)
	if textureView == nil {
		C.go_wgpuRelease(api.textureRelease, texturePtr)
		return errors.New("missing texture view")
	}

	encoder := C.go_wgpuDeviceCreateCommandEncoder(api.deviceCreateCommandEncoder, context.Device, nil)
	if encoder == nil {
		C.go_wgpuRelease(api.textureViewRelease, textureView)
		C.go_wgpuRelease(api.textureRelease, texturePtr)
		return errors.New("missing command encoder")
	}

	colorAttachment := make([]byte, 72)
	writePtr(colorAttachment, 8, textureView)
	writeU32(colorAttachment, 16, wgpuDepthSliceUndefined)
	writePtr(colorAttachment, 24, nil)
	writeU32(colorAttachment, 32, wgpuLoadOpClear)
	writeU32(colorAttachment, 36, wgpuStoreOpStore)
	writeF64(colorAttachment, 40, 0.007)
	writeF64(colorAttachment, 48, 0.010)
	writeF64(colorAttachment, 56, 0.015)
	writeF64(colorAttachment, 64, 1.0)

	passDescriptor := make([]byte, 64)
	writeU64(passDescriptor, 24, 1)
	writePtr(passDescriptor, 32, ptrFromBytes(colorAttachment))
	pass := C.go_wgpuCommandEncoderBeginRenderPass(api.commandEncoderBeginRenderPass, encoder, ptrFromBytes(passDescriptor))
	if pass == nil {
		C.go_wgpuRelease(api.commandEncoderRelease, encoder)
		C.go_wgpuRelease(api.textureViewRelease, textureView)
		C.go_wgpuRelease(api.textureRelease, texturePtr)
		return errors.New("missing render pass")
	}

	vertexCount := uint32(len(vertices) / floatsPerVertex)
	C.go_wgpuRenderPassEncoderSetPipeline(api.renderPassEncoderSetPipeline, pass, pipeline.pipeline)
	C.go_wgpuRenderPassEncoderSetVertexBuffer(api.renderPassEncoderSetVertexBuff, pass, 0, pipeline.vertexBuffer, C.uint64_t(0), C.uint64_t(activeBytes))
	C.go_wgpuRenderPassEncoderDraw(api.renderPassEncoderDraw, pass, C.uint32_t(vertexCount), 1, 0, 0)
	C.go_wgpuRenderPassEncoderEnd(api.renderPassEncoderEnd, pass)

	commandBuffer := C.go_wgpuCommandEncoderFinish(api.commandEncoderFinish, encoder, nil)
	if commandBuffer == nil {
		C.go_wgpuRelease(api.commandEncoderRelease, encoder)
		C.go_wgpuRelease(api.textureViewRelease, textureView)
		C.go_wgpuRelease(api.textureRelease, texturePtr)
		return errors.New("missing command buffer")
	}

	command := uintptr(commandBuffer)
	C.go_wgpuQueueSubmit(api.queueSubmit, queue, C.uint64_t(1), unsafe.Pointer(&command))
	if _, err := core.WgpuSurfacePresentMainThread(context.Surface); err != nil {
		return err
	}

	C.go_wgpuRelease(api.commandBufferRelease, commandBuffer)
	C.go_wgpuRelease(api.commandEncoderRelease, encoder)
	C.go_wgpuRelease(api.textureViewRelease, textureView)
	C.go_wgpuRelease(api.textureRelease, texturePtr)
	return nil
}

func sendMazeFrame(snapshot mazeSnapshot, fps float64) {
	if !hostQueueRunning.Load() || snapshot.HostWebviewID == 0 {
		return
	}
	payload := fmt.Sprintf(
		`{"status":%s,"columns":%d,"rows":%d,"cells":%d,"visited":%d,"frontier":%d,"path":%d,"fps":%f}`,
		electrobun.JsonStringLiteral(snapshot.Status),
		snapshot.Columns,
		snapshot.Rows,
		snapshot.Cells,
		snapshot.Visited,
		snapshot.Frontier,
		snapshot.Path,
		fps,
	)
	sendRPCMessage(snapshot.HostWebviewID, "mazeFrame", payload)
}

func sendRPCMessage(webviewID uint32, messageID, payloadJSON string) {
	packet := fmt.Sprintf(`{"type":"message","id":%s,"payload":%s}`, electrobun.JsonStringLiteral(messageID), payloadJSON)
	if err := state.core.SendHostMessageToWebviewJSON(webviewID, packet); err != nil {
		handleWebviewSendError("send RPC message", err)
	}
}

func sendRPCResponseSuccess(webviewID uint32, requestID uint64, payloadJSON string) {
	packet := fmt.Sprintf(`{"type":"response","id":%d,"success":true,"payload":%s}`, requestID, payloadJSON)
	if err := state.core.SendHostMessageToWebviewJSON(webviewID, packet); err != nil {
		handleWebviewSendError("send RPC response", err)
	}
}

func sendRPCResponseError(webviewID uint32, requestID uint64, message string) {
	packet := fmt.Sprintf(`{"type":"response","id":%d,"success":false,"error":%s}`, requestID, electrobun.JsonStringLiteral(message))
	if err := state.core.SendHostMessageToWebviewJSON(webviewID, packet); err != nil {
		handleWebviewSendError("send RPC error", err)
	}
}

func handleWebviewSendError(action string, err error) {
	if strings.Contains(err.Error(), "not found") {
		requestShutdown()
		return
	}
	if !shuttingDown.Load() {
		fmt.Fprintf(os.Stderr, "[go-maze-wgpu] failed to %s: %s\n", action, err)
	}
}

func makeShaderSourceWGSL(codePtr unsafe.Pointer) []byte {
	const (
		wgpuSTypeShaderSourceWGSL = uint32(0x00000002)
		wgpuStrlen                = ^uint64(0)
	)
	bytes := make([]byte, 32)
	writePtr(bytes, 0, nil)
	writeU32(bytes, 8, wgpuSTypeShaderSourceWGSL)
	writePtr(bytes, 16, codePtr)
	writeU64(bytes, 24, wgpuStrlen)
	return bytes
}

func makeShaderModuleDescriptor(sourcePtr unsafe.Pointer) []byte {
	bytes := make([]byte, 24)
	writePtr(bytes, 0, sourcePtr)
	writePtr(bytes, 8, nil)
	writeU64(bytes, 16, 0)
	return bytes
}

func writeVertexAttribute(bytes []byte, index int, offset uint64, location uint32, format uint32) {
	base := index * 32
	writePtr(bytes, base, nil)
	writeU32(bytes, base+8, format)
	writeU64(bytes, base+16, offset)
	writeU32(bytes, base+24, location)
}

func makeVertexBufferLayout(attributesPtr unsafe.Pointer, attributeCount uint64) []byte {
	const wgpuVertexStepModeVertex = uint32(0x00000001)
	bytes := make([]byte, 40)
	writePtr(bytes, 0, nil)
	writeU32(bytes, 8, wgpuVertexStepModeVertex)
	writeU64(bytes, 16, vertexStride)
	writeU64(bytes, 24, attributeCount)
	writePtr(bytes, 32, attributesPtr)
	return bytes
}

func makeColorTargetState(format uint32) []byte {
	const wgpuColorWriteMaskAll = uint64(0x000000000000000f)
	bytes := make([]byte, 32)
	writePtr(bytes, 0, nil)
	writeU32(bytes, 8, format)
	writePtr(bytes, 16, nil)
	writeU64(bytes, 24, wgpuColorWriteMaskAll)
	return bytes
}

func makeVertexState(module unsafe.Pointer, entry unsafe.Pointer, vertexLayoutPtr unsafe.Pointer) []byte {
	const wgpuStrlen = ^uint64(0)
	bytes := make([]byte, 64)
	writePtr(bytes, 0, nil)
	writePtr(bytes, 8, module)
	writePtr(bytes, 16, entry)
	writeU64(bytes, 24, wgpuStrlen)
	writeU64(bytes, 32, 0)
	writePtr(bytes, 40, nil)
	writeU64(bytes, 48, 1)
	writePtr(bytes, 56, vertexLayoutPtr)
	return bytes
}

func makeFragmentState(module unsafe.Pointer, entry unsafe.Pointer, colorTargetPtr unsafe.Pointer) []byte {
	const wgpuStrlen = ^uint64(0)
	bytes := make([]byte, 64)
	writePtr(bytes, 0, nil)
	writePtr(bytes, 8, module)
	writePtr(bytes, 16, entry)
	writeU64(bytes, 24, wgpuStrlen)
	writeU64(bytes, 32, 0)
	writePtr(bytes, 40, nil)
	writeU64(bytes, 48, 1)
	writePtr(bytes, 56, colorTargetPtr)
	return bytes
}

func makePrimitiveState() []byte {
	const (
		wgpuPrimitiveTopologyTriangleList = uint32(0x00000004)
		wgpuFrontFaceCCW                  = uint32(0x00000001)
		wgpuCullModeNone                  = uint32(0x00000001)
	)
	bytes := make([]byte, 32)
	writePtr(bytes, 0, nil)
	writeU32(bytes, 8, wgpuPrimitiveTopologyTriangleList)
	writeU32(bytes, 16, wgpuFrontFaceCCW)
	writeU32(bytes, 20, wgpuCullModeNone)
	return bytes
}

func makeMultisampleState() []byte {
	bytes := make([]byte, 24)
	writePtr(bytes, 0, nil)
	writeU32(bytes, 8, 1)
	writeU32(bytes, 12, 0xffffffff)
	return bytes
}

func makeRenderPipelineDescriptor(vertexState, primitiveState, multisampleState []byte, fragmentStatePtr unsafe.Pointer) []byte {
	bytes := make([]byte, 168)
	writePtr(bytes, 0, nil)
	writePtr(bytes, 8, nil)
	writeU64(bytes, 16, 0)
	writePtr(bytes, 24, nil)
	copy(bytes[32:96], vertexState)
	copy(bytes[96:128], primitiveState)
	writePtr(bytes, 128, nil)
	copy(bytes[136:160], multisampleState)
	writePtr(bytes, 160, fragmentStatePtr)
	return bytes
}

func makeBufferDescriptor(size uint64) []byte {
	const (
		wgpuBufferUsageVertex  = uint64(0x0000000000000020)
		wgpuBufferUsageCopyDst = uint64(0x0000000000000008)
	)
	bytes := make([]byte, 48)
	writePtr(bytes, 0, nil)
	writePtr(bytes, 8, nil)
	writeU64(bytes, 16, 0)
	writeU64(bytes, 24, wgpuBufferUsageVertex|wgpuBufferUsageCopyDst)
	writeU64(bytes, 32, size)
	return bytes
}

func ptrFromBytes(bytes []byte) unsafe.Pointer {
	if len(bytes) == 0 {
		return nil
	}
	return unsafe.Pointer(&bytes[0])
}

func writePtr(bytes []byte, offset int, ptr unsafe.Pointer) {
	writeU64(bytes, offset, uint64(uintptr(ptr)))
}

func writeU32(bytes []byte, offset int, value uint32) {
	binary.LittleEndian.PutUint32(bytes[offset:], value)
}

func writeU64(bytes []byte, offset int, value uint64) {
	binary.LittleEndian.PutUint64(bytes[offset:], value)
}

func writeF64(bytes []byte, offset int, value float64) {
	writeU64(bytes, offset, math.Float64bits(value))
}

func readU32(bytes []byte, offset int) uint32 {
	return binary.LittleEndian.Uint32(bytes[offset:])
}

func readU64(bytes []byte, offset int) uint64 {
	return binary.LittleEndian.Uint64(bytes[offset:])
}

func clampInt(value, minValue, maxValue int) int {
	if value < minValue {
		return minValue
	}
	if value > maxValue {
		return maxValue
	}
	return value
}

func maxUint32(a, b uint32) uint32 {
	if a > b {
		return a
	}
	return b
}
