const std = @import("std");
const rpc = @import("../rpc/schema/request.zig");
const rpcSchema = @import("../rpc/schema/schema.zig");
const objc = @import("./objc.zig");
const pipesin = @import("../rpc/pipesin.zig");
const window = @import("./window.zig");
const rpcTypes = @import("../rpc/types.zig");
const rpcHandlers = @import("../rpc/schema/handlers.zig");
const utils = @import("../utils.zig");


const strEql = utils.strEql;

const O_NONBLOCK = 0x0004; // For Unix-based systems

const alloc = std.heap.page_allocator;

pub const NavigationRule = struct {
    pattern: []const u8,
    is_deny_rule: bool,

    pub fn fromString(allocator: std.mem.Allocator, str: []const u8) ?NavigationRule {
        const trimmed = std.mem.trim(u8, str, " ");
        if (trimmed.len == 0) return null;
        
        const pattern = if (trimmed[0] == '^') 
            allocator.dupe(u8, trimmed[1..]) catch return null
            else allocator.dupe(u8, trimmed) catch return null;
            
        return NavigationRule{
            .pattern = pattern,
            .is_deny_rule = trimmed[0] == '^',
        };
    }

    pub fn deinit(self: *const NavigationRule, allocator: std.mem.Allocator) void {
        allocator.free(self.pattern);
    }
};
// eg: 
// block everything, except wikipedia.org and subdomains like en.wikipedia.org
// "^*, *.wikipedia.org, wikipedia.org"

// allow everything, except wikipedia.org and subdomains like en.wikipedia.org
// "^*.wikipedia.org, ^wikipedia.org"

pub const NavigationRuleList = struct {
    rules: []NavigationRule,
    allocator: std.mem.Allocator,

    pub fn init(allocator: std.mem.Allocator) NavigationRuleList {
        return .{
            .rules = &[_]NavigationRule{},
            .allocator = allocator,
        };
    }

    pub fn deinit(self: *NavigationRuleList) void {
        for (self.rules) |rule| {
            rule.deinit(self.allocator);
        }
        self.allocator.free(self.rules);
    }

    // Note: we store the rules backwards so developers can write them from general to specific
    // and so we can iterate from specific to general (stopping at the first encountered match)

    // comma separated list of rules
    // use a * to match any character
    // start with a ^ to make it a deny rule
    pub fn fromString(allocator: std.mem.Allocator, rules_str: ?[]const u8) NavigationRuleList {
        var list = NavigationRuleList.init(allocator);
        
        const str = rules_str orelse return list;
        if (str.len == 0) return list;
        
        var rules = std.ArrayList(NavigationRule).init(allocator);
        
        var it = std.mem.split(u8, str, ",");
        while (it.next()) |rule_str| {
            if (NavigationRule.fromString(allocator, rule_str)) |rule| {
                // Insert at beginning to reverse order
                rules.insert(0, rule) catch continue;
            }
        }

        list.rules = rules.toOwnedSlice() catch {
            rules.deinit();
            return list;
        };
        
        return list;
    }

    pub fn isUrlAllowed(self: *const NavigationRuleList, url: []const u8) bool {
         const uri = std.Uri.parse(url) catch return true;
        
        // No scheme? Match against full URL as pattern
        if (uri.scheme.len == 0) {
            for (self.rules) |rule| {
                if (std.mem.eql(u8, rule.pattern, url)) {
                    return !rule.is_deny_rule;
                }
            }
            return true;
        }

        // Has scheme but no host? Match against just the scheme
        const host = uri.host orelse {
            const scheme = uri.scheme;
            for (self.rules) |rule| {
                if (std.mem.eql(u8, rule.pattern, scheme)) {
                    return !rule.is_deny_rule;
                }
            }
            return true;
        };

        // Regular domain matching
        for (self.rules) |rule| {
            if (self.matchesDomainPattern(rule.pattern, host.percent_encoded)) {
                return !rule.is_deny_rule;
            }
        }

        return true;
    }

    fn matchesDomainPattern(self: *const NavigationRuleList, pattern: []const u8, host: []const u8) bool {
        _ = self;
        if (std.mem.eql(u8, pattern, "*")) return true;
        
        if (pattern[0] == '*' and pattern.len > 1 and pattern[1] == '.') {
            return std.mem.endsWith(u8, host, pattern[2..]);
        }

        return std.mem.eql(u8, pattern, host);
    }
};


const WebviewMap = std.AutoHashMap(u32, WebviewType);
pub var webviewMap: WebviewMap = WebviewMap.init(alloc);
const ViewsScheme = "views://";

fn assetFileLoader(url: [*:0]const u8) callconv(.C) objc.FileResponse {
    const relPath = url[ViewsScheme.len..std.mem.len(url)];
    const fileContents = readFileContentsFromDisk(relPath) catch "failed to load contents";
    const mimeType = getMimeType(relPath); // or dynamically determine MIME type
    return objc.FileResponse{ .mimeType = utils.toCString(mimeType), .fileContents = fileContents.ptr, .len = fileContents.len, .opaquePointer = null };
}

fn readAssetFromDisk(url: [*:0]const u8) []const u8 {
    const relPath = url[ViewsScheme.len..std.mem.len(url)];
    const fileContents = readFileContentsFromDisk(relPath) catch "failed to load contents";
    return fileContents;
}

const WebviewType = struct {
    id: u32,
    handle: *anyopaque,
    hostWebviewId: ?u32,
    frame: struct {
        width: f64,
        height: f64,
        x: f64,
        y: f64,
    },
    renderer: []const u8, // native, cef, etc.
    navigationRules: NavigationRuleList,
    // todo: de-init these using objc.releaseObjCObject() when the webview closes
    // delegate: *anyopaque,
    // bunBridgeHandler: *anyopaque,
    // webviewTagHandler: *anyopaque,
    bun_out_pipe: ?std.fs.File, //?anyerror!std.fs.File,
    bun_in_pipe: ?std.fs.File,
    // Function to send a message to Bun
    pub fn sendToBun(self: *WebviewType, message: []const u8) !void {
        const chunk_size: usize = 4 * 1024; // 4KB chunk size
        var offset: usize = 0;

        if (self.bun_out_pipe) |file| {
            while (offset < message.len) {
                const remaining = message.len - offset;
                var current_chunk: []const u8 = undefined;

                if (remaining > chunk_size) {
                    current_chunk = message[offset .. offset + chunk_size];
                } else {
                    current_chunk = message[offset..];
                }

                try file.writeAll(current_chunk);

                offset += current_chunk.len;
            }

            // Write the final newline after all chunks are sent
            try file.writeAll("\n");
        } else {
            // If bun_out_pipe is null, print an error or the message to stdio
            std.debug.print("Error: No valid pipe to write to. Message was: {s}\n", .{message});
        }
    }

    pub fn sendToWebview(self: *WebviewType, message: []const u8) void {
        objc.evaluateJavaScriptWithNoCompletion(self.handle, utils.toCString(message));
    }

    pub fn sendToWebviewSecureWorld(self: *WebviewType, message: []const u8) void {
        objc.evaluateJavaScriptinSecureContentWorld(self.handle, utils.toCString(message));
    }

    pub fn deinit(self: *WebviewType) void {
        // todo: implement the rest of this including objc stuff
        if (self.bun_out_pipe) |file| {
            file.close();
        }
        if (self.bun_in_pipe) |file| {
            file.close();
        }
    }
};

const CreateWebviewOpts = struct { //
    id: u32,
    windowId: u32,
    renderer: []const u8,
    hostWebviewId: ?u32,
    rpcPort: u32,
    secretKey: []const u8,
    pipePrefix: []const u8,
    url: ?[]const u8,
    html: ?[]const u8,
    preload: ?[]const u8,
    partition: ?[]const u8,
    frame: struct { //
        width: f64,
        height: f64,
        x: f64,
        y: f64,
    },
    autoResize: bool,
    navigationRules: ?[]const u8,
};
pub fn createWebview(opts: CreateWebviewOpts) void {
    const bunPipeIn = blk: {
        const bunPipeInPath = utils.concatStrings(opts.pipePrefix, "_in");
        const bunPipeInFileResult = std.fs.cwd().openFile(bunPipeInPath, .{ .mode = .read_only });

        if (bunPipeInFileResult) |file| {
            break :blk file;
        } else |err| {
            std.debug.print("Failed to open bunPipeIn: {}\n", .{err});
            std.debug.print("path: {s}", .{bunPipeInPath});
            break :blk null;
        }
    };

    if (bunPipeIn) |pipeInFile| {
        pipesin.addPipe(pipeInFile.handle, opts.id);
    }

    const bunPipeOut = blk: {
        const bunPipeOutPath = utils.concatStrings(opts.pipePrefix, "_out");
        const bunPipeOutResult = std.fs.cwd().openFile(bunPipeOutPath, .{ .mode = .read_write });

        if (bunPipeOutResult) |file| {
            // open in non-blocking mode
            // const flags = std.os.fcntl(file.handle, std.os.F.GETFL, 0) catch {
            //     std.debug.print("Failed to get flags on bunPipeOut\n", .{});
            //     return;
            // };
            // _ = std.os.fcntl(file.handle, std.os.F.SETFL, flags | O_NONBLOCK) catch {
            //     std.debug.print("Failed to set O_NONBLOCK on bunPipeOut\n", .{});
            // };
            break :blk file;
        } else |err| {
            std.debug.print("Failed to open bunPipeOut: {}\n", .{err});
            std.debug.print("path: {s}", .{bunPipeOutPath});
            break :blk null;
        }
    };

    const viewsHandler = struct {
        fn viewsHandler(webviewId: u32, url: [*:0]const u8, body: [*:0]const u8) callconv(.C) objc.FileResponse {
            const relPath = url[ViewsScheme.len..std.mem.len(url)];

            if (std.mem.eql(u8, relPath, "syncrpc")) {
                // Note: We use the views:// url scheme here so that we can issue our synchronous xhr
                // request against the same origin that other local content is loaded from.
                // js loaded from other sources (http, etc.) will be blocked (CORS) from initiating
                // synchronous requests to bun.
                return assetFileLoader(url);
                // const bodyString = utils.fromCString(body);

                // const response = rpc.request.sendSyncRequest(.{ .webviewId = webviewId, .request = bodyString });
                // if (response.payload) |payload| {
                //     const responseString = payload[0..payload.len];
                //     return objc.FileResponse{ .mimeType = utils.toCString("application/json"), .fileContents = responseString.ptr, .len = responseString.len, .opaquePointer = null };
                // } else {
                //     std.debug.print("Failed to get response from sync rpc request, no payload\n", .{});
                // }
            } else if (std.mem.eql(u8, relPath, "rpc")) {
                const bodyString = utils.fromCString(body);

                var webview = webviewMap.get(webviewId) orelse {
                    std.debug.print("Failed to get webview from hashmap for id {}: screenshot api\n", .{webviewId});
                    return assetFileLoader(url);
                };

                webview.sendToBun(bodyString) catch |err| {
                    std.debug.print("Failed to send message to bun: {}\n", .{err});
                };

                const responseString = "";

                return objc.FileResponse{ .mimeType = utils.toCString("text/plaintext"), .fileContents = responseString.ptr, .len = responseString.len, .opaquePointer = null };
            } else if (std.mem.startsWith(u8, relPath, "screenshot/")) {
                // the relPath is screenshot/<webviewId>?<cachebuster>
                // get the target webview info for objc, the screenshoting and resolving is done
                // in objc
                const start = "screenshot/".len;
                const end = std.mem.indexOf(u8, relPath, "?") orelse relPath.len;
                const numStr = relPath[start..end];
                const targetWebviewId = std.fmt.parseInt(u32, numStr, 10) catch 0;

                const targetWebview = webviewMap.get(targetWebviewId) orelse {
                    std.debug.print("Failed to get webview from hashmap for id {}: screenshot api\n", .{targetWebviewId});
                    return assetFileLoader(url);
                };

                // const fileContents = readFileContentsFromDisk(relPath) catch "failed to load contents";
                // const mimeType = getMimeType(relPath); // or dynamically determine MIME type
                return objc.FileResponse{ .opaquePointer = targetWebview.handle, .mimeType = utils.toCString("screenshot"), .fileContents = utils.toCString(""), .len = 0 };
            }

            return assetFileLoader(url);
        }
    }.viewsHandler;

    const parition = opts.partition orelse "persist:default";

    const win = window.windowMap.get(opts.windowId) orelse {
        std.debug.print("Failed to get window from hashmap for id {}\n", .{opts.windowId});
        return;
    };

    // todo: windowId should actually be a pointer to the window
    const objcWebview = objc.initWebview(opts.id, win.window, utils.toCString(opts.renderer), .{                
        // .frame = .{ //
        .origin = .{ .x = opts.frame.x, .y = opts.frame.y },
        .size = .{ .width = opts.frame.width, .height = opts.frame.height },
        // },
    }, viewsHandler, opts.autoResize, utils.toCString(parition), struct {
        fn decideNavigation(webviewId: u32, url: [*:0]const u8) callconv(.C) bool {
            // _ = webviewId;
            // _ = url;
            // todo: right now this reaches a generic rpc request, but it should be attached
            // to this specific webview's pipe so navigation handlers can be attached to specific webviews
            // const _response = rpc.request.decideNavigation(.{
            //     .webviewId = webviewId,
            //     .url = utils.fromCString(url),
            // });

            // TODO: Bun should provide this webview a rule list instead of it fireing an event

            const webview = webviewMap.get(webviewId) orelse {
                std.debug.print("Failed to get webview from hashmap for id {}: decideNavigation\n", .{webviewId});
                return false;
            };

            return webview.navigationRules.isUrlAllowed(utils.fromCString(url));
            
        }
    }.decideNavigation, struct {
        fn handleWebviewEvent(webviewId: u32, eventName: ?[*:0]const u8, url: ?[*:0]const u8) callconv(.C) void {
            webviewEvent(.{
                .id = webviewId,
                .eventName = utils.fromCString(eventName),
                .detail = utils.fromCString(url),
            });
        }
    }.handleWebviewEvent, struct {
        fn BunBridgeHandler(webviewId: u32, message: [*:0]const u8) callconv(.C) void {
            // bun bridge just forwards messages to the bun
            var webview = webviewMap.get(webviewId) orelse {
                std.debug.print("Failed to get webview from hashmap for id {}: bunBridgeHandler\n", .{webviewId});
                return;
            };

            webview.sendToBun(utils.fromCString(message)) catch |err| {
                std.debug.print("Failed to send message to bun: {}\n", .{err});
            };
        }
    }.BunBridgeHandler, struct {
        fn WebviewTagBridgeHandler(webviewId: u32, message: [*:0]const u8) callconv(.C) void {
            const msgString = utils.fromCString(message);

            const json = std.json.parseFromSlice(std.json.Value, alloc, msgString, .{ .ignore_unknown_fields = true }) catch |err| {
                std.log.info("Error parsing line from webview-zig-bridge - {}: \nreceived: {s}", .{ err, msgString });
                return;
            };

            defer json.deinit();

            const msgType = blk: {
                const obj = json.value.object.get("type").?;
                break :blk obj.string;
            };

            if (std.mem.eql(u8, msgType, "request")) {
                const _request = std.json.parseFromValue(rpcTypes._RPCRequestPacket, alloc, json.value, .{}) catch |err| {
                    std.log.info("Error parsing line from webview-zig-bridge - {}: \nreceived: {s}", .{ err, msgString });
                    return;
                };

                const result = rpcHandlers.fromBrowserHandleRequest(_request.value);

                if (result.errorMsg == null) {
                    const responseSuccess = .{ .id = _request.value.id, .type = "response", .success = true, .payload = result };

                    const buffer = std.json.stringifyAlloc(alloc, responseSuccess, .{}) catch {
                        return;
                    };
                    defer alloc.free(buffer);

                    // Prepare the JavaScript function call
                    const jsCall = std.fmt.allocPrint(alloc, "window.__electrobun.receiveMessageFromZig({s})\n", .{buffer}) catch {
                        return;
                    };
                    defer alloc.free(jsCall);

                    sendLineToWebview(webviewId, jsCall);
                } else {
                    // todo: this doesn't work yet
                    // rpcStdout.sendResponseError(_request.value.id, result.errorMsg.?);
                }
            } else if (std.mem.eql(u8, msgType, "message")) {
                const _message = std.json.parseFromValue(rpcTypes._RPCMessagePacket, alloc, json.value, .{}) catch |err| {
                    std.log.info("Error parsing line from webview-zig-bridge - {}: \nreceived: {s}", .{ err, msgString });
                    return;
                };

                rpcHandlers.fromBrowserHandleMessage(_message.value);
            } else {
                std.log.info("it's an unhandled meatball", .{});
            }
        }
    }.WebviewTagBridgeHandler);


    // const bunBridgeHandler = objc.addScriptMessageHandler(objcWebview, opts.id, "bunBridge", struct {
    //     fn BunBridgeHandler(webviewId: u32, message: [*:0]const u8) callconv(.C) void {
    //         // bun bridge just forwards messages to the bun
    //         var webview = webviewMap.get(webviewId) orelse {
    //             std.debug.print("Failed to get webview from hashmap for id {}: bunBridgeHandler\n", .{webviewId});
    //             return;
    //         };

    //         webview.sendToBun(utils.fromCString(message)) catch |err| {
    //             std.debug.print("Failed to send message to bun: {}\n", .{err});
    //         };
    //     }
    // }.BunBridgeHandler);
    // todo: only set this up if the webview tag is enabled for this webview
    // todo: rename this to webviewToZigBridgeHandler since it's for webview tags and the webview itself
    // const webviewTagHandler = objc.addScriptMessageHandler(objcWebview, opts.id, "webviewTagBridge", struct {
    //     fn HandlePostMessage(webviewId: u32, message: [*:0]const u8) callconv(.C) void {
    //         const msgString = utils.fromCString(message);

    //         const json = std.json.parseFromSlice(std.json.Value, alloc, msgString, .{ .ignore_unknown_fields = true }) catch |err| {
    //             std.log.info("Error parsing line from webview-zig-bridge - {}: \nreceived: {s}", .{ err, msgString });
    //             return;
    //         };

    //         defer json.deinit();

    //         const msgType = blk: {
    //             const obj = json.value.object.get("type").?;
    //             break :blk obj.string;
    //         };

    //         if (std.mem.eql(u8, msgType, "request")) {
    //             const _request = std.json.parseFromValue(rpcTypes._RPCRequestPacket, alloc, json.value, .{}) catch |err| {
    //                 std.log.info("Error parsing line from webview-zig-bridge - {}: \nreceived: {s}", .{ err, msgString });
    //                 return;
    //             };

    //             const result = rpcHandlers.fromBrowserHandleRequest(_request.value);

    //             if (result.errorMsg == null) {
    //                 const responseSuccess = .{ .id = _request.value.id, .type = "response", .success = true, .payload = result };

    //                 const buffer = std.json.stringifyAlloc(alloc, responseSuccess, .{}) catch {
    //                     return;
    //                 };
    //                 defer alloc.free(buffer);

    //                 // Prepare the JavaScript function call
    //                 const jsCall = std.fmt.allocPrint(alloc, "window.__electrobun.receiveMessageFromZig({s})\n", .{buffer}) catch {
    //                     return;
    //                 };
    //                 defer alloc.free(jsCall);

    //                 sendLineToWebview(webviewId, jsCall);
    //             } else {
    //                 // todo: this doesn't work yet
    //                 // rpcStdout.sendResponseError(_request.value.id, result.errorMsg.?);
    //             }
    //         } else if (std.mem.eql(u8, msgType, "message")) {
    //             const _message = std.json.parseFromValue(rpcTypes._RPCMessagePacket, alloc, json.value, .{}) catch |err| {
    //                 std.log.info("Error parsing line from webview-zig-bridge - {}: \nreceived: {s}", .{ err, msgString });
    //                 return;
    //             };

    //             rpcHandlers.fromBrowserHandleMessage(_message.value);
    //         } else {
    //             std.log.info("it's an unhandled meatball", .{});
    //         }
    //     }
    // }.HandlePostMessage);

    const _webview = WebviewType{ //
        .id = opts.id,
        .hostWebviewId = opts.hostWebviewId,
        // .windowId = opts.windowId,
        .renderer = opts.renderer,
        .frame = .{
            .width = opts.frame.width,
            .height = opts.frame.height,
            .x = opts.frame.x,
            .y = opts.frame.y,
        },
        .handle = objcWebview,
        .bun_out_pipe = bunPipeOut,
        .bun_in_pipe = bunPipeIn,
        .navigationRules = NavigationRuleList.fromString(alloc, opts.navigationRules),
        // .delegate = delegate,
        // .bunBridgeHandler = bunBridgeHandler,
        // .webviewTagHandler = webviewTagHandler,
    };

    webviewMap.put(opts.id, _webview) catch {
        std.log.info("Error putting webview into hashmap: ", .{});
        return;
    };

    // Note: The only way for code in the secure world to communicate with the page world
    // is via postMessage which requires serialization. So might be useful but not for efficient rpc.
    // objc.evaluateJavaScriptinSecureContentWorld(_webview.handle, utils.toCString(
    //     \\ const test = 567;
    //     \\ console.log('test', test);
    //     \\ window.test44 = 44;
    // ));
    // objc.evaluateJavaScriptWithNoCompletion(_webview.handle, utils.toCString("const test = 567; console.log('test', test);"));
    
    // Note: Keep this in sync with browser api
    const jsScriptSubstitutions = std.fmt.allocPrint(alloc,
        \\ window.__electrobunWebviewId = {};
        \\ window.__electrobunWindowId = {}
        \\window.__electrobunRpcSocketPort = {};
        \\(async () => {{
        \\
        \\ function base64ToUint8Array(base64) {{
        \\   return new Uint8Array(atob(base64).split('').map(char => char.charCodeAt(0)));
        \\ }}
        \\
        \\function uint8ArrayToBase64(uint8Array) {{
        \\ let binary = '';
        \\ for (let i = 0; i < uint8Array.length; i++) {{
        \\   binary += String.fromCharCode(uint8Array[i]);
        \\ }}
        \\ return btoa(binary);
        \\}}
        \\ const generateKeyFromText = async (rawKey) => {{
        // \\   const encoder = new TextEncoder();
        // \\   const rawKey = encoder.encode(text); // Convert the text to a Uint8Array
        \\ 
        \\   return await window.crypto.subtle.importKey(
        \\     'raw',                  // Key format
        \\     rawKey,                 // Key data
        \\     {{ name: 'AES-GCM' }},    // Algorithm details
        \\     true,                   // Extractable (set to false for better security)
        \\     ['encrypt', 'decrypt']  // Key usages
        \\   );
        \\ }};        
        \\ const secretKey = await generateKeyFromText(new Uint8Array([{s}]));
        \\
        \\ const encryptString = async (plaintext) => {{
        \\   const encoder = new TextEncoder();
        \\   const encodedText = encoder.encode(plaintext);
        \\   const iv = window.crypto.getRandomValues(new Uint8Array(12)); // Initialization vector (12 bytes)
        \\   const encryptedBuffer = await window.crypto.subtle.encrypt(
        \\    {{
        \\     name: "AES-GCM",
        \\     iv: iv,
        \\    }},
        \\    secretKey,
        \\    encodedText
        \\   );
        \\        
        \\        
        \\   // Split the tag (last 16 bytes) from the ciphertext
        \\   const encryptedData = new Uint8Array(encryptedBuffer.slice(0, -16));
        \\   const tag = new Uint8Array(encryptedBuffer.slice(-16));
        \\
        \\   return {{ encryptedData: uint8ArrayToBase64(encryptedData), iv: uint8ArrayToBase64(iv), tag: uint8ArrayToBase64(tag) }};
        \\ }};
        \\ 
        \\ // All args passed in as base64 strings
        \\ const decryptString = async (encryptedData, iv, tag) => {{
        \\  encryptedData = base64ToUint8Array(encryptedData);
        \\  iv = base64ToUint8Array(iv);
        \\  tag = base64ToUint8Array(tag);
        \\  // Combine encrypted data and tag to match the format expected by SubtleCrypto
        \\  const combinedData = new Uint8Array(encryptedData.length + tag.length);
        \\  combinedData.set(encryptedData);
        \\  combinedData.set(tag, encryptedData.length);
        \\  const decryptedBuffer = await window.crypto.subtle.decrypt(
        \\    {{
        \\      name: "AES-GCM",
        \\      iv: iv,
        \\    }},
        \\    secretKey,
        \\    combinedData // Pass the combined data (ciphertext + tag)
        \\  );
        \\  const decoder = new TextDecoder();
        \\  return decoder.decode(decryptedBuffer);
        \\ }};
        \\
        \\ window.__electrobun_encrypt = encryptString;
        \\ window.__electrobun_decrypt = decryptString;
        \\}})()
        \\
    , .{ opts.id, opts.windowId, opts.rpcPort, opts.secretKey }) catch {
        // NOTE: key must be at least 32 characters long
        return;
    };
    defer alloc.free(jsScriptSubstitutions);

    // todo: move this to a separate file and embed it in zig so it can be properly
    // edited as js
    const jsScript = utils.concatStrings(jsScriptSubstitutions,
        \\ function emitWebviewEvent (eventName, detail) {
        \\     window.webkit.messageHandlers.webviewTagBridge.postMessage(JSON.stringify({id: 'webviewEvent', type: 'message', payload: {id: window.__electrobunWebviewId, eventName, detail}}));
        \\ };                 
        \\
        \\ window.addEventListener('load', function(event) {
        \\   // Check if the current window is the top-level window        
        \\   if (window === window.top) {        
        \\    emitWebviewEvent('dom-ready', document.location.href);        
        \\   }
        \\ });
        \\
        \\ window.addEventListener('popstate', function(event) {
        \\  emitWebviewEvent('did-navigate-in-page', window.location.href);
        \\ });
        \\
        \\ window.addEventListener('hashchange', function(event) {
        \\  emitWebviewEvent('did-navigate-in-page', window.location.href);    
        \\ });
        \\
        \\ document.addEventListener('click', function(event) {
        \\  if ((event.metaKey || event.ctrlKey) && event.target.tagName === 'A') {
        \\    event.preventDefault();
        \\    event.stopPropagation();
        \\
        \\    // Get the href of the link
        \\    const url = event.target.href;        
        \\    
        \\    // Open the URL in a new window or tab
        \\    // Note: we already handle new windows in objc
        \\    window.open(url, '_blank');
        \\  }
        \\}, true);
        \\
    );

    // we want to make this a preload script so that it gets re-applied after navigations before any
    // other code runs.
    addPreloadScriptToWebview(_webview.handle, jsScript, false);

    // Add user's custom preload script if set
    if (opts.preload) |preload| {
        updatePreloadScriptToWebview(opts.id, "electrobun_custom_preload_script", preload, true);
    }
}

// todo: move everything to cStrings or non-CStrings. just pick one.
pub fn addPreloadScriptToWebview(webview: *anyopaque, scriptOrPath: []const u8, allFrames: bool) void {
    var script: []const u8 = undefined;

    // If it's a views:// url safely load from disk otherwise treat it as js
    if (std.mem.startsWith(u8, scriptOrPath, ViewsScheme)) {
        const fileResult = readAssetFromDisk(utils.toCString(scriptOrPath));
        script = fileResult;
    } else {
        script = scriptOrPath;
    }

    objc.addPreloadScriptToWebView(webview, utils.toCString(script), allFrames);
}

pub fn updatePreloadScriptToWebview(webviewId: u32, identifier: []const u8, scriptOrPath: []const u8, allFrames: bool) void {
    const webview = webviewMap.get(webviewId) orelse {
        std.debug.print("Failed to get webview from hashmap for id {}: resizeWebview\n", .{webviewId});
        return;
    };

    var script: []const u8 = undefined;

    // If it's a views:// url safely load from disk otherwise treat it as js
    if (std.mem.startsWith(u8, scriptOrPath, ViewsScheme)) {
        const fileResult = readAssetFromDisk(utils.toCString(scriptOrPath));
        script = fileResult;
    } else {
        script = scriptOrPath;
    }

    // todo: remove only the user-defined custom script

    objc.updatePreloadScriptToWebView(webview.handle, utils.toCString(identifier), utils.toCString(script), allFrames);
}

pub fn resizeWebview(opts: rpcSchema.BrowserSchema.messages.webviewTagResize) void {
    const webview = webviewMap.get(opts.id) orelse {
        std.debug.print("Failed to get webview from hashmap for id {}: resizeWebview\n", .{opts.id});
        return;
    };

    std.debug.print("===========-------- resizeWebview:: {}", .{opts.id});

    // todo: update webview frame in the webviewMap.
    // not doing this yet to see when we run into issues. it's possible
    // we don't need to store this in zig at all since the "last one set"
    // is in bun or webview (in the case of webview tags) and "current one"
    // is in objc
    objc.resizeWebview(webview.handle, .{
        .origin = .{ .x = opts.frame.x, .y = opts.frame.y },
        .size = .{ .width = opts.frame.width, .height = opts.frame.height },
    }, utils.toCString(opts.masks));
}

pub fn canGoBack(opts: rpcSchema.BrowserSchema.requests.webviewTagCanGoBack.params) bool {
    const webview = webviewMap.get(opts.id) orelse {
        std.debug.print("Failed to get webview from hashmap for id {}: canGoBack\n", .{opts.id});
        return false;
    };

    return objc.webviewCanGoBack(webview.handle);
}

pub fn canGoForward(opts: rpcSchema.BrowserSchema.requests.webviewTagCanGoForward.params) bool {
    const webview = webviewMap.get(opts.id) orelse {
        std.debug.print("Failed to get webview from hashmap for id {}: canGoForward\n", .{opts.id});
        return false;
    };

    return objc.webviewCanGoForward(webview.handle);
}

pub fn loadURL(opts: rpcSchema.BunSchema.requests.loadURL.params) void {
    const webview = webviewMap.get(opts.webviewId) orelse {
        std.debug.print("Failed to get webview from hashmap for id {}: loadURL\n", .{opts.webviewId});
        return;
    };
    std.debug.print("zig: loadURL: {s}\n", .{opts.url});
    // todo: consider updating url. we may not need it stored in zig though.
    // webview.url = need to use webviewMap.getPtr() then webview.*.url = opts.url
    objc.loadURLInWebView(webview.handle, utils.toCString(opts.url));
}

pub fn loadHTML(opts: rpcSchema.BunSchema.requests.loadHTML.params) void {
    const webview = webviewMap.get(opts.webviewId) orelse {
        std.debug.print("Failed to get webview from hashmap for id {}: loadHTML\n", .{opts.webviewId});
        return;
    };

    // webview.html = opts.html;
    objc.loadHTMLInWebView(webview.handle, utils.toCString(opts.html));
}

pub fn goBack(opts: rpcSchema.BrowserSchema.messages.webviewTagGoBack) void {
    const webview = webviewMap.get(opts.id) orelse {
        std.debug.print("Failed to get webview from hashmap for id {}\n", .{opts.id});
        return;
    };

    objc.webviewTagGoBack(webview.handle);
}
pub fn goForward(opts: rpcSchema.BrowserSchema.messages.webviewTagGoForward) void {
    const webview = webviewMap.get(opts.id) orelse {
        std.debug.print("Failed to get webview from hashmap for id {}\n", .{opts.id});
        return;
    };

    objc.webviewTagGoForward(webview.handle);
}
pub fn reload(opts: rpcSchema.BrowserSchema.messages.webviewTagReload) void {
    const webview = webviewMap.get(opts.id) orelse {
        std.debug.print("Failed to get webview from hashmap for id {}\n", .{opts.id});
        return;
    };

    objc.webviewTagReload(webview.handle);
}

pub fn webviewTagSetTransparent(opts: rpcSchema.BrowserSchema.messages.webviewTagSetTransparent) void {
    const webview = webviewMap.get(opts.id) orelse {
        std.debug.print("Failed to get webview from hashmap for id {}\n", .{opts.id});
        return;
    };

    objc.webviewTagSetTransparent(webview.handle, opts.transparent);
}

pub fn webviewTagToggleMirroring(opts: rpcSchema.BrowserSchema.messages.webviewTagToggleMirroring) void {
    const webview = webviewMap.get(opts.id) orelse {
        std.debug.print("Failed to get webview from hashmap for id {}\n", .{opts.id});
        return;
    };

    objc.webviewTagToggleMirroring(webview.handle, opts.enable);
}

pub fn webviewTagSetPassthrough(opts: rpcSchema.BrowserSchema.messages.webviewTagSetPassthrough) void {
    const webview = webviewMap.get(opts.id) orelse {
        std.debug.print("Failed to get webview from hashmap for id {}\n", .{opts.id});
        return;
    };

    objc.webviewTagSetPassthrough(webview.handle, opts.enablePassthrough);
}

pub fn webviewSetHidden(opts: rpcSchema.BrowserSchema.messages.webviewTagSetHidden) void {
    const webview = webviewMap.get(opts.id) orelse {
        std.debug.print("Failed to get webview from hashmap for id {}\n", .{opts.id});
        return;
    };

    objc.webviewSetHidden(webview.handle, opts.hidden);
}

pub fn webviewEvent(opts: rpcSchema.BrowserSchema.messages.webviewEvent) void {
    const webview = webviewMap.get(opts.id) orelse {
        std.debug.print("Failed to get webview from hashmap for id {}\n", .{opts.id});
        return;
    };

    // todo: we need these to timeout
    rpc.request.webviewEvent(.{
        .id = webview.id,
        .eventName = opts.eventName,
        .detail = opts.detail,
    });

    // If this is a webview tag, we need to forward the event to the host webview so any in-browser listeners
    // can be notified.
    if (webview.hostWebviewId) |hostId| {
        // todo: can we type this at all? maybe convert to json or something.
        // todo: use a global register in the browser-context for webview tags instead of querySelectors and attributes
        // Note: see webviewtag. emitEvent(name, detail) {}
        const jsCall = std.fmt.allocPrint(alloc, "document.querySelector('#electrobun-webview-{d}').emit(`{s}`, `{s}`);\n", .{ webview.id, opts.eventName, opts.detail }) catch {
            return;
        };
        defer alloc.free(jsCall);

        sendLineToWebview(hostId, jsCall);
    }
}

pub fn remove(opts: rpcSchema.BrowserSchema.messages.webviewTagRemove) void {
    var webview = webviewMap.get(opts.id) orelse {
        std.debug.print("Failed to get webview from hashmap for id {}\n", .{opts.id});
        return;
    };

    objc.webviewRemove(webview.handle);
    _ = webviewMap.remove(opts.id);

    // todo: remove it from the window map as well

    webview.deinit();
}

pub fn sendLineToWebview(webviewId: u32, line: []const u8) void {
    var webview = webviewMap.get(webviewId) orelse {
        std.debug.print("Failed to get webview from hashmap for id {}: sendLineToWebview, line: {s}\n", .{ webviewId, line });
        return;
    };

    webview.sendToWebview(line);
}

// This will wait for promises if a promise is returned from the dev's script and call the completion handler when done
pub fn callAsyncJavaScript(messageId: []const u8, webviewId: u32, hostWebviewId: u32, script: []const u8, handler: objc.callAsyncJavascriptCompletionHandler) void {
    const webview = webviewMap.get(webviewId) orelse {
        std.debug.print("Failed to get webview from hashmap for id {}: callAsyncJavaScript, line: {s}\n", .{ webviewId, script });
        return;
    };

    objc.callAsyncJavaScript(utils.toCString(messageId), webview.handle, utils.toCString(script), webviewId, hostWebviewId, handler);
}

// todo: this should move to util, but we need CString utils (which should also be moved to a util)
pub fn moveToTrash(filePath: []const u8) bool {
    const path = utils.toCString(filePath);
    std.debug.print("moving to trash path: {s}\n", .{filePath});
    return objc.moveToTrash(path);
}
// todo: this should move to util, but we need CString utils (which should also be moved to a util)
pub fn showItemInFolder(filePath: []const u8) bool {
    const path = utils.toCString(filePath);
    std.debug.print("moving to trash path: {s}\n", .{filePath});
    return objc.showItemInFolder(path);
}

// todo: this should move to util, but we need CString utils (which should also be moved to a util)
pub fn openFileDialog(startingFolder: []const u8, allowedFileTypes: []const u8, canChooseFiles: bool, canChooseDirectory: bool, allowsMultipleSelection: bool) []const u8 {
    const _chosenPath = objc.openFileDialog(utils.toCString(startingFolder), utils.toCString(allowedFileTypes), canChooseFiles, canChooseDirectory, allowsMultipleSelection);

    if (_chosenPath) |chosenPath| {
        return utils.fromCString(chosenPath);
    } else {
        return "";
    }
}

pub fn readFileContentsFromDisk(filePath: []const u8) ![]const u8 {
    const ELECTROBUN_VIEWS_FOLDER = std.posix.getenv("ELECTROBUN_VIEWS_FOLDER") orelse {
        // todo: return an error here
        return error.ELECTROBUN_VIEWS_FOLDER_NOT_SET;
    };

    // Note: resolve the path, then check if it's not a descendant
    const joinedPath = try std.fs.path.join(alloc, &.{ ELECTROBUN_VIEWS_FOLDER, filePath });
    const resolvedPath = try std.fs.path.resolve(alloc, &.{joinedPath});
    defer alloc.free(resolvedPath);
    const relativePath = try std.fs.path.relative(alloc, ELECTROBUN_VIEWS_FOLDER, resolvedPath);
    defer alloc.free(relativePath);

    // Should defend against trying to load content outside of the build/views folder
    // eg: relative and absolute urls
    // url: 'assets://mainview/index.html',
    // url: 'assets://mainview/../../bun/index.js', // /Users/yoav/code/electrobun/example/build/bun/index.js
    // url: 'assets://../bun/index.js', // /Users/yoav/code/electrobun/example/build/bun/index.js
    // url: 'assets://%2E%2E/bun/index.js',
    // url: 'assets:////Users/yoav/code/electrobun/example/build/bun/index.js', ///Users/yoav/code/electrobun/example/build/bun/index.js
    if (relativePath[0] == '.' and relativePath[1] == '.') {
        return error.InvalidPath;
    }

    const file = try std.fs.cwd().openFile(resolvedPath, .{});
    defer file.close();

    const fileSize = try file.getEndPos();
    const fileContents = try alloc.alloc(u8, fileSize);

    // Read the file contents into the allocated buffer
    _ = try file.readAll(fileContents);

    return fileContents;
}

// todo: move to string utils
pub fn getMimeType(filePath: []const u8) []const u8 {
    const extension = std.fs.path.extension(filePath);

    if (strEql(extension, ".html")) {
        return "text/html";
    } else if (strEql(extension, ".htm")) {
        return "text/html";
    } else if (strEql(extension, ".js")) {
        return "application/javascript";
    } else if (strEql(extension, ".json")) {
        return "application/json";
    } else if (strEql(extension, ".css")) {
        return "text/css";
    } else if (strEql(extension, ".ttf")) {
        return "font/ttf";
    } else if (strEql(extension, ".png")) {
        return "image/png";
    } else if (strEql(extension, ".jpg")) {
        return "image/jpeg";
    } else if (strEql(extension, ".jpeg")) {
        return "image/jpeg";
    } else if (strEql(extension, ".gif")) {
        return "image/gif";
    } else if (strEql(extension, ".svg")) {
        return "image/svg+xml";
    } else if (strEql(extension, ".txt")) {
        return "text/plain";
    } else {
        return "application/octet-stream";
    }
}

fn findLastIndexOfChar(slice: []const u8, char: u8) ?usize {
    var i: usize = slice.len;
    while (i > 0) : (i -= 1) {
        if (slice[i - 1] == char) {
            return i - 1;
        }
    }
    return null;
}
