const std = @import("std");
const c = @cImport({
    @cInclude("llama.h");
});

pub const LlamaContext = opaque {};
pub const LlamaModel = opaque {};
pub const LlamaBatch = opaque {};

pub const Token = c.llama_token;
pub const Pos = c.llama_pos;
pub const SeqId = c.llama_seq_id;

pub const SamplingParams = struct {
    temperature: f32 = 0.1,
    top_k: i32 = 40,
    top_p: f32 = 0.95,
    min_p: f32 = 0.05,
    tfs_z: f32 = 1.0,
    typical_p: f32 = 1.0,
    repeat_penalty: f32 = 1.1,
    repeat_last_n: i32 = 64,
    penalize_nl: bool = false,
    seed: u32 = 0xFFFFFFFF,
};

pub const GenerationConfig = struct {
    max_tokens: u32 = 100,
    stop_tokens: []const []const u8 = &.{},
    stream_callback: ?*const fn (token: []const u8) void = null,
};

pub const LlamaError = error{
    ModelLoadFailed,
    ContextCreationFailed,
    TokenizationFailed,
    DecodeFailed,
    InvalidInput,
    OutOfMemory,
};

pub fn initBackend() void {
    c.llama_backend_init();
}

pub fn initBackendQuiet() void {
    // For now, just use normal backend init
    // TODO: Research proper llama.cpp logging control
    c.llama_backend_init();
}

pub fn freeBackend() void {
    c.llama_backend_free();
}

pub const Model = struct {
    ptr: *c.llama_model,
    
    pub fn load(path: []const u8, allocator: std.mem.Allocator) !Model {
        const path_z = try allocator.dupeZ(u8, path);
        defer allocator.free(path_z);
        
        var params = c.llama_model_default_params();
        params.n_gpu_layers = 0; // CPU only for now
        params.use_mmap = true;
        params.use_mlock = false;
        
        const model = c.llama_load_model_from_file(path_z.ptr, params);
        if (model == null) {
            return LlamaError.ModelLoadFailed;
        }
        
        return Model{ .ptr = model.? };
    }
    
    pub fn deinit(self: Model) void {
        c.llama_free_model(self.ptr);
    }
    
    pub fn tokenCount(self: Model) u32 {
        return @intCast(c.llama_n_vocab(self.ptr));
    }
    
    pub fn contextLength(self: Model) u32 {
        return @intCast(c.llama_n_ctx_train(self.ptr));
    }
};

pub const Context = struct {
    ptr: *c.llama_context,
    model: *const Model,
    
    pub fn init(model: *const Model, n_ctx: u32, n_batch: u32, n_threads: u32) !Context {
        var params = c.llama_context_default_params();
        params.n_ctx = @intCast(n_ctx);
        params.n_batch = @intCast(n_batch);
        params.n_threads = @intCast(n_threads);
        params.n_threads_batch = @intCast(n_threads);
        
        const ctx = c.llama_new_context_with_model(model.ptr, params);
        if (ctx == null) {
            return LlamaError.ContextCreationFailed;
        }
        
        return Context{
            .ptr = ctx.?,
            .model = model,
        };
    }
    
    pub fn deinit(self: Context) void {
        c.llama_free(self.ptr);
    }
    
    pub fn tokenize(self: Context, text: []const u8, allocator: std.mem.Allocator) ![]Token {
        const max_tokens = text.len + 100; // Conservative estimate
        const tokens = try allocator.alloc(Token, max_tokens);
        
        // Get the vocab from the model
        const vocab = c.llama_model_get_vocab(self.model.ptr);
        
        const n_tokens = c.llama_tokenize(
            vocab,
            text.ptr,
            @intCast(text.len),
            tokens.ptr,
            @intCast(max_tokens),
            true,  // add_special
            false, // parse_special
        );
        
        if (n_tokens < 0) {
            allocator.free(tokens);
            return LlamaError.TokenizationFailed;
        }
        
        return try allocator.realloc(tokens, @intCast(n_tokens));
    }
    
    pub fn tokenToString(self: Context, token: Token, allocator: std.mem.Allocator) ![]u8 {
        var buffer: [512]u8 = undefined;
        const vocab = c.llama_model_get_vocab(self.model.ptr);
        const n = c.llama_token_to_piece(vocab, token, &buffer, buffer.len, 0, false);
        
        if (n < 0) {
            return LlamaError.InvalidInput;
        }
        
        return try allocator.dupe(u8, buffer[0..@intCast(n)]);
    }
    
    pub fn decode(self: Context, tokens: []const Token, pos: Pos) !void {
        var batch = c.llama_batch_init(@intCast(tokens.len), 0, 1);
        defer c.llama_batch_free(batch);
        
        batch.n_tokens = @intCast(tokens.len);
        for (tokens, 0..) |token, i| {
            batch.token[i] = token;
            batch.pos[i] = pos + @as(Pos, @intCast(i));
            batch.n_seq_id[i] = 1;
            batch.seq_id[i][0] = 0;
            batch.logits[i] = if (i == tokens.len - 1) 1 else 0;
        }
        
        const result = c.llama_decode(self.ptr, batch);
        if (result != 0) {
            return LlamaError.DecodeFailed;
        }
    }
    
    pub fn sampleToken(self: Context, params: SamplingParams) Token {
        // Create a sampler chain with the desired parameters
        var sampler_params = c.llama_sampler_chain_default_params();
        sampler_params.no_perf = false;
        
        const sampler_chain = c.llama_sampler_chain_init(sampler_params);
        defer c.llama_sampler_free(sampler_chain);
        
        // Add samplers in order (only use available ones)
        c.llama_sampler_chain_add(sampler_chain, c.llama_sampler_init_top_k(params.top_k));
        c.llama_sampler_chain_add(sampler_chain, c.llama_sampler_init_typical(params.typical_p, 1));
        c.llama_sampler_chain_add(sampler_chain, c.llama_sampler_init_top_p(params.top_p, 1));
        c.llama_sampler_chain_add(sampler_chain, c.llama_sampler_init_min_p(params.min_p, 1));
        c.llama_sampler_chain_add(sampler_chain, c.llama_sampler_init_temp(params.temperature));
        c.llama_sampler_chain_add(sampler_chain, c.llama_sampler_init_dist(params.seed));
        
        // Sample using the new API
        return c.llama_sampler_sample(sampler_chain, self.ptr, -1);
    }
    
    pub fn isEosToken(self: Context, token: Token) bool {
        const vocab = c.llama_model_get_vocab(self.model.ptr);
        return c.llama_vocab_is_eog(vocab, token);
    }
};

pub fn generate(
    context: *Context,
    prompt: []const u8,
    params: SamplingParams,
    config: GenerationConfig,
    allocator: std.mem.Allocator,
) ![]u8 {
    // Tokenize prompt
    const prompt_tokens = try context.tokenize(prompt, allocator);
    defer allocator.free(prompt_tokens);
    
    // Decode prompt
    try context.decode(prompt_tokens, 0);
    
    var generated = std.ArrayList(u8).init(allocator);
    defer generated.deinit();
    
    var n_cur = prompt_tokens.len;
    var n_generated: u32 = 0;
    
    while (n_generated < config.max_tokens) {
        // Sample next token
        const token = context.sampleToken(params);
        
        // Check for EOS
        if (context.isEosToken(token)) {
            break;
        }
        
        // Convert token to string
        const token_str = try context.tokenToString(token, allocator);
        defer allocator.free(token_str);
        
        // Check for stop tokens
        var should_stop = false;
        for (config.stop_tokens) |stop| {
            if (std.mem.indexOf(u8, token_str, stop) != null) {
                should_stop = true;
                break;
            }
        }
        
        if (should_stop) {
            break;
        }
        
        // Append to output
        try generated.appendSlice(token_str);
        
        // Stream callback if provided
        if (config.stream_callback) |callback| {
            callback(token_str);
        }
        
        // Prepare for next iteration
        const next_tokens = [_]Token{token};
        try context.decode(&next_tokens, @intCast(n_cur));
        n_cur += 1;
        n_generated += 1;
    }
    
    return try generated.toOwnedSlice();
}