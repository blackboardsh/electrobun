const std = @import("std");
const dispatch = @cImport({
    @cInclude("dispatch/dispatch.h");
});

var bunPipeInFile: std.fs.File = undefined;
var pipeToCli: std.fs.File = undefined;
var child_process: std.ChildProcess = undefined;

pub fn main() !void {
    std.log.info("launching launcher!", .{});

    var allocator = std.heap.page_allocator;

    // try get the absolute path to the executable inside the app bundle
    // to set the cwd. Otherwise it's likely to be / or ~/ depending on how the app was launched
    const args = try std.process.argsAlloc(allocator);
    defer std.process.argsFree(allocator, args);
    const cwd = std.fs.path.dirname(args[0]).?;

    // Create an instance of ChildProcess
    const argv = &[_][]const u8{ "./bun", "../Resources/app/bun/index.js" };
    child_process = std.ChildProcess.init(argv, allocator);

    child_process.cwd = cwd;

    // // TMP DEBUG
    // // Open the file on the desktop for writing
    const file = try std.fs.cwd().openFile("/Users/yoav/Desktop/debug.txt", .{ .mode = .write_only });
    defer file.close();

    // if (fileResult) |file| {
    file.writeAll(cwd) catch |err| {
        std.debug.print("Failed to write to file: {}\n", .{err});
    };

    // send to cli
    const toCliPipePath = try std.fs.path.join(allocator, &.{ cwd, "../Resources/debug/toCli" });
    pipeToCli = try std.fs.cwd().openFile(toCliPipePath, .{ .mode = .read_write });
    // if (bunPipeOutFileResult) |pipeToCli| {
    pipeToCli.writeAll("hello") catch |err| {
        std.debug.print("Failed to write to pipeToCli: {}\n", .{err});
    };

    pipeToCli.writeAll("\n") catch |err| {
        std.debug.print("Failed to write to pipeToCli: {}\n", .{err});
    };
    // } else {
    //     std.debug.print("Failed to open bunPipeOutFile: {}\n", .{toCliPipePath});
    // }

    // have a tiny zig launcher for canary and stable builds
    // for dev builds, just copy the cli in as the launcher, and use the cli on both sides
    // with typescript rpcanywhere

    // note: we can't use hashbang files because they won't work on windows.
    // with both sides as the bun cli, we can share code, types, etc. and move functionality
    // back and forth as it evolves.
    // with the dev launcher as a bun single-file-executable it also makes it easier to pipe/inherit
    // stdio.

    // in canary/stable builds we don't want to use bun sfe as a launcher, we want to use a zig
    // launcher and the regular bun runtime. This is because we want to be able to update the
    // bun runtime without electrobun staying up to date shipping cli version being a blocker for people to update their apps.
    // although if we use the cli for .build commands then it already is a blocker.

    // since the user has bun installed via npm, maybe they can build the cli into a sfe themselves.
    // currently the SFE can't execute more typescript, so we need to ship the runtime separately anyway.
    // The SFE also needs to bundle external assets and things

    // receive from cli
    const toLauncherPath = try std.fs.path.join(allocator, &.{ cwd, "../Resources/debug/toLauncher" });
    bunPipeInFile = try std.fs.cwd().openFile(toLauncherPath, .{ .mode = .read_only });

    // listen on the pipesin on another thread
    _ = try std.Thread.spawn(.{}, pipeInListener, .{});

    sendToCli("before spawnWait on thread");
    // _ = try std.Thread.spawn(.{}, spawnWait, .{});
    sendToCli("before spawnWait");
    try spawnWait();
    sendToCli("after spawnWait");

    // Wait for the subprocess to complete
    // const exit_code = child_process.wait() catch |err| {
    //     std.debug.print("Failed to wait for child process: {}\n", .{err});
    //     return;
    // };

    // std.debug.print("Subprocess exited with code: {}\n", .{exit_code});
}

var doLoop = true;

fn pipeInListener() void {
    const stdin = bunPipeInFile.reader();
    // Note: this is a zig string.
    var buffer: [1024]u8 = undefined;
    std.log.info("launcher listening to in pipe", .{});

    sendToCli("launcher listening to in pipe");
    while (true) {
        const bytesRead = stdin.readUntilDelimiterOrEof(&buffer, '\n') catch continue;
        if (bytesRead) |line| {
            std.log.info("launcher received line from cli: {s}", .{line});
            sendToCli("launcher received line from cli: ");
            sendToCli(line);

            if (std.mem.eql(u8, line, "exit command")) {
                sendToCli("killing");
                doLoop = false;
                // killinIt(null);
                std.process.exit(0);
                // dispatch.dispatch_async_f(dispatch.dispatch_get_main_queue(), null, killinIt);
            }
            // const messageWithType = std.json.parseFromSlice(rpcTypes._RPCMessage, alloc, line, .{ .ignore_unknown_fields = true }) catch |err| {
            //     std.log.info("Error parsing line from stdin - {}: \nreceived: {s}", .{ err, line });
            //     continue;
            // };

            // if (std.mem.eql(u8, messageWithType.value.type, "response")) {

            //     // todo: handle _RPCResponsePacketError
            //     const _response = std.json.parseFromSlice(rpcTypes._RPCResponsePacketSuccess, alloc, line, .{}) catch |err| {
            //         std.log.info("Error parsing line from stdin - {}: \nreceived: {s}", .{ err, line });
            //         continue;
            //     };
            //     // handle response
            //     // _response = payload.allow;

            //     std.log.info("decide Navigation - {}", .{_response.value.payload.?});

            //     rpcStdout.setResponse(messageWithType.value.id, _response.value.payload);
            // } else {
            //     // Handle UI events on main thread
            //     // since line is re-used we need to copy it to the heap
            //     const lineCopy = alloc.dupe(u8, line) catch {
            //         // Handle the error here, e.g., log it or set a default value
            //         std.debug.print("Error: {s}\n", .{line});
            //         continue;
            //     };

            //     messageQueue.append(lineCopy) catch {
            //         std.log.info("Error appending to messageQueue: \nreceived: {s}", .{line});
            //         continue;
            //     };

            //     dispatch.dispatch_async_f(dispatch.dispatch_get_main_queue(), null, processMessageQueue);

            //     std.log.info("sending over to main thread", .{});
            // }
        }
    }
}

fn sendToCli(message: []const u8) void {
    pipeToCli.writeAll(message) catch |err| {
        std.debug.print("Failed to write to pipeToCli: {}\n", .{err});
    };

    pipeToCli.writeAll("\n") catch |err| {
        std.debug.print("Failed to write to pipeToCli: {}\n", .{err});
    };
}

pub fn spawnWait() !void {
    sendToCli("spawnWait");
    // Set the command and arguments
    try child_process.spawn();
    defer {
        _ = child_process.kill() catch {
            std.log.info("Failed to kill child process", .{});
        };
    }

    const exit_code = child_process.wait() catch |err| {
        std.debug.print("Failed to wait for child process: {}\n", .{err});
        return;
    };

    std.debug.print("Subprocess exited with code: {}\n", .{exit_code});
}

pub fn killinIt(_: ?*anyopaque) callconv(.C) void {
    std.log.info("killing on main", .{});
    sendToCli("killing on main");
    _ = child_process.kill() catch {
        std.log.info("Failed to kill child process", .{});
    };
    std.process.exit(0);
}
