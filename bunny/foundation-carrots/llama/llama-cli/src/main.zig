const std = @import("std");
const print = std.debug.print;

// Import build options to determine llama support
const build_options = @import("build_options_default.zig");
const has_llama = build_options.has_llama;

const llama = if (has_llama) @import("llama_bindings.zig") else struct {
    // Stub definitions when llama.cpp is not available
    pub fn initBackend() void {}
    pub fn freeBackend() void {}
    
    // Define stub types for compilation
    pub const Model = struct {
        pub fn load(path: []const u8, allocator: std.mem.Allocator) !Model {
            _ = path; _ = allocator;
            return Model{};
        }
        pub fn deinit(self: Model) void { _ = self; }
    };
    pub const Context = struct {
        pub fn init(model: *const Model, n_ctx: u32, n_batch: u32, n_threads: u32) !Context {
            _ = model; _ = n_ctx; _ = n_batch; _ = n_threads;
            return Context{};
        }
        pub fn deinit(self: Context) void { _ = self; }
    };
    pub const SamplingParams = struct {
        temperature: f32 = 0.1,
        top_k: i32 = 40,
        top_p: f32 = 0.95,
        repeat_penalty: f32 = 1.1,
    };
    pub const GenerationConfig = struct {
        max_tokens: u32 = 100,
        stop_tokens: []const []const u8 = &.{},
        stream_callback: ?*const fn (token: []const u8) void = null,
    };
    pub fn generate(
        context: *Context,
        prompt: []const u8,
        params: SamplingParams,
        config: GenerationConfig,
        allocator: std.mem.Allocator,
    ) ![]u8 {
        _ = context; _ = prompt; _ = params; _ = config;
        return allocator.dupe(u8, "stub result");
    }
};
const ArrayList = std.ArrayList;
const Allocator = std.mem.Allocator;

const Config = struct {
    model_path: []const u8,
    prompt: []const u8,
    temperature: f32 = 0.1,
    max_tokens: u32 = 100,
    stop_tokens: ArrayList([]const u8),
    top_p: f32 = 0.95,
    top_k: i32 = 40,
    repeat_penalty: f32 = 1.1,
    n_threads: u32 = 4,
    n_ctx: u32 = 2048,
    stream: bool = true,
    quiet: bool = false,
    mock: bool = false,
    
    pub fn deinit(self: *Config, allocator: Allocator) void {
        if (self.model_path.len > 0) {
            allocator.free(self.model_path);
        }
        if (self.prompt.len > 0) {
            allocator.free(self.prompt);
        }
        for (self.stop_tokens.items) |token| {
            allocator.free(token);
        }
        self.stop_tokens.deinit();
    }
};

fn printUsage() void {
    print("Usage: llama-cli [options]\n", .{});
    print("Options:\n", .{});
    print("  --model PATH        Path to the GGUF model file (required)\n", .{});
    print("  --prompt TEXT       Input prompt (required, or read from stdin)\n", .{});
    print("  --temperature FLOAT Temperature for sampling (default: 0.1)\n", .{});
    print("  --max-tokens INT    Maximum tokens to generate (default: 100)\n", .{});
    print("  --top-p FLOAT       Top-p sampling parameter (default: 0.95)\n", .{});
    print("  --top-k INT         Top-k sampling parameter (default: 40)\n", .{});
    print("  --repeat-penalty FLOAT Repeat penalty (default: 1.1)\n", .{});
    print("  --n-threads INT     Number of threads to use (default: 4)\n", .{});
    print("  --n-ctx INT         Context size (default: 2048)\n", .{});
    print("  --stop TOKEN        Stop token (can be used multiple times)\n", .{});
    print("  --no-stream         Disable streaming output\n", .{});
    print("  --quiet             Suppress verbose model loading output\n", .{});
    print("  --mock              Use mock completion mode (for testing)\n", .{});
    print("  --help              Show this help message\n", .{});
}

fn parseArgs(allocator: Allocator) !Config {
    const args = try std.process.argsAlloc(allocator);
    defer std.process.argsFree(allocator, args);
    
    var config = Config{
        .model_path = "",
        .prompt = "",
        .stop_tokens = ArrayList([]const u8).init(allocator),
    };
    
    if (args.len < 2) {
        printUsage();
        std.process.exit(1);
    }
    
    var i: usize = 1;
    while (i < args.len) {
        const arg = args[i];
        
        if (std.mem.eql(u8, arg, "--help")) {
            printUsage();
            std.process.exit(0);
        } else if (std.mem.eql(u8, arg, "--model")) {
            if (i + 1 >= args.len) {
                print("Error: --model requires a value\n", .{});
                std.process.exit(1);
            }
            i += 1;
            config.model_path = try allocator.dupe(u8, args[i]);
        } else if (std.mem.eql(u8, arg, "--prompt")) {
            if (i + 1 >= args.len) {
                print("Error: --prompt requires a value\n", .{});
                std.process.exit(1);
            }
            i += 1;
            config.prompt = try allocator.dupe(u8, args[i]);
        } else if (std.mem.eql(u8, arg, "--temperature")) {
            if (i + 1 >= args.len) {
                print("Error: --temperature requires a value\n", .{});
                std.process.exit(1);
            }
            i += 1;
            config.temperature = std.fmt.parseFloat(f32, args[i]) catch {
                print("Error: Invalid temperature value\n", .{});
                std.process.exit(1);
            };
        } else if (std.mem.eql(u8, arg, "--max-tokens") or std.mem.eql(u8, arg, "--n-predict")) {
            if (i + 1 >= args.len) {
                print("Error: --max-tokens/--n-predict requires a value\n", .{});
                std.process.exit(1);
            }
            i += 1;
            config.max_tokens = std.fmt.parseInt(u32, args[i], 10) catch {
                print("Error: Invalid max-tokens/n-predict value\n", .{});
                std.process.exit(1);
            };
        } else if (std.mem.eql(u8, arg, "--top-p")) {
            if (i + 1 >= args.len) {
                print("Error: --top-p requires a value\n", .{});
                std.process.exit(1);
            }
            i += 1;
            config.top_p = std.fmt.parseFloat(f32, args[i]) catch {
                print("Error: Invalid top-p value\n", .{});
                std.process.exit(1);
            };
        } else if (std.mem.eql(u8, arg, "--top-k")) {
            if (i + 1 >= args.len) {
                print("Error: --top-k requires a value\n", .{});
                std.process.exit(1);
            }
            i += 1;
            config.top_k = std.fmt.parseInt(i32, args[i], 10) catch {
                print("Error: Invalid top-k value\n", .{});
                std.process.exit(1);
            };
        } else if (std.mem.eql(u8, arg, "--repeat-penalty")) {
            if (i + 1 >= args.len) {
                print("Error: --repeat-penalty requires a value\n", .{});
                std.process.exit(1);
            }
            i += 1;
            config.repeat_penalty = std.fmt.parseFloat(f32, args[i]) catch {
                print("Error: Invalid repeat-penalty value\n", .{});
                std.process.exit(1);
            };
        } else if (std.mem.eql(u8, arg, "--n-threads")) {
            if (i + 1 >= args.len) {
                print("Error: --n-threads requires a value\n", .{});
                std.process.exit(1);
            }
            i += 1;
            config.n_threads = std.fmt.parseInt(u32, args[i], 10) catch {
                print("Error: Invalid n-threads value\n", .{});
                std.process.exit(1);
            };
        } else if (std.mem.eql(u8, arg, "--n-ctx")) {
            if (i + 1 >= args.len) {
                print("Error: --n-ctx requires a value\n", .{});
                std.process.exit(1);
            }
            i += 1;
            config.n_ctx = std.fmt.parseInt(u32, args[i], 10) catch {
                print("Error: Invalid n-ctx value\n", .{});
                std.process.exit(1);
            };
        } else if (std.mem.eql(u8, arg, "--stop")) {
            if (i + 1 >= args.len) {
                print("Error: --stop requires a value\n", .{});
                std.process.exit(1);
            }
            i += 1;
            const stop_token = try allocator.dupe(u8, args[i]);
            try config.stop_tokens.append(stop_token);
        } else if (std.mem.eql(u8, arg, "--no-stream")) {
            config.stream = false;
        } else if (std.mem.eql(u8, arg, "--quiet")) {
            config.quiet = true;
        } else if (std.mem.eql(u8, arg, "--mock")) {
            config.mock = true;
        } else {
            print("Error: Unknown argument: {s}\n", .{arg});
            std.process.exit(1);
        }
        
        i += 1;
    }
    
    if (config.model_path.len == 0 and !config.mock) {
        print("Error: --model is required (unless using --mock mode)\n", .{});
        std.process.exit(1);
    }
    
    // If no prompt provided, read from stdin
    if (config.prompt.len == 0) {
        const stdin = std.io.getStdIn().reader();
        const prompt_input = try stdin.readAllAlloc(allocator, 1024 * 1024); // 1MB max
        config.prompt = prompt_input;
    }
    
    return config;
}

// Signal handler for graceful cancellation
var should_exit = std.atomic.Value(bool).init(false);
var generation_cancelled = std.atomic.Value(bool).init(false);

fn signalHandler(sig: c_int) callconv(.C) void {
    _ = sig;
    should_exit.store(true, .release);
    generation_cancelled.store(true, .release);
    // Output newline to clean up streaming output
    const stdout = std.io.getStdOut().writer();
    stdout.writeAll("\n") catch {};
}

// Streaming callback function
fn streamCallback(token: []const u8) void {
    // Check if generation was cancelled
    if (generation_cancelled.load(.acquire)) {
        return;
    }
    
    const stdout = std.io.getStdOut().writer();
    stdout.writeAll(token) catch {
        // If writing fails, mark as cancelled
        generation_cancelled.store(true, .release);
    };
}

// IMPORTANT: NO MOCK COMPLETIONS SHOULD EVER BE USED FOR REAL APPLICATIONS
// This function should NEVER be used in production - only real model completions
// Mock completions are disabled - this function should return empty results
fn getMockCompletion(prompt: []const u8, temperature: f32) []const u8 {
    _ = prompt;
    _ = temperature;
    // Return empty string - we only want real model completions, never mock ones
    return "";
}

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();
    
    // Note: llama backend initialization moved to conditional block
    
    // Set up signal handlers for cancellation
    const sigint_action = std.posix.Sigaction{
        .handler = .{ .handler = signalHandler },
        .mask = std.posix.empty_sigset,
        .flags = 0,
    };
    
    try std.posix.sigaction(std.posix.SIG.INT, &sigint_action, null);
    try std.posix.sigaction(std.posix.SIG.TERM, &sigint_action, null);
    
    // Parse configuration
    var config = parseArgs(allocator) catch |err| {
        print("Error parsing arguments: {}\n", .{err});
        std.process.exit(1);
    };
    defer config.deinit(allocator);
    
    // Check for cancellation before starting
    if (should_exit.load(.acquire)) {
        std.process.exit(130); // 128 + SIGINT
    }
    
    var result: []u8 = undefined;
    
    if (config.mock) {
        // Use mock completion
        const mock_result = getMockCompletion(config.prompt, config.temperature);
        result = try allocator.dupe(u8, mock_result);
        
        // Stream output if requested
        if (config.stream) {
            streamCallback(result);
        }
    } else {
        if (has_llama) {
            // Initialize llama backend (quiet or normal mode)
            if (config.quiet) {
                llama.initBackendQuiet();
            } else {
                llama.initBackend();
            }
            defer llama.freeBackend();
            
            // Load model
            const model = llama.Model.load(config.model_path, allocator) catch |err| {
                print("Error loading model: {}\n", .{err});
                std.process.exit(1);
            };
            defer model.deinit();
            
            // Create context
            var context = llama.Context.init(&model, config.n_ctx, 512, config.n_threads) catch |err| {
                print("Error creating context: {}\n", .{err});
                std.process.exit(1);
            };
            defer context.deinit();
            
            // Set up sampling parameters
            const sampling_params = llama.SamplingParams{
                .temperature = config.temperature,
                .top_k = config.top_k,
                .top_p = config.top_p,
                .repeat_penalty = config.repeat_penalty,
            };
            
            // Set up generation configuration
            const gen_config = llama.GenerationConfig{
                .max_tokens = config.max_tokens,
                .stop_tokens = config.stop_tokens.items,
                .stream_callback = if (config.stream) streamCallback else null,
            };
            
            // Generate completion
            result = llama.generate(
                &context,
                config.prompt,
                sampling_params,
                gen_config,
                allocator,
            ) catch |err| {
                if (generation_cancelled.load(.acquire)) {
                    std.process.exit(130); // 128 + SIGINT
                }
                print("Error generating completion: {}\n", .{err});
                std.process.exit(1);
            };
        } else {
            print("Error: Real model mode requires llama.cpp support. Use --mock for testing.\n", .{});
            std.process.exit(1);
        }
    }
    
    defer allocator.free(result);
    
    // Check for cancellation after generation
    if (should_exit.load(.acquire)) {
        std.process.exit(130); // 128 + SIGINT
    }
    
    // Output result if not streaming (streaming already outputs during generation)
    if (!config.stream) {
        const stdout = std.io.getStdOut().writer();
        try stdout.writeAll(result);
    }
}