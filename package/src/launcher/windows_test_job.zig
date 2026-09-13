const std = @import("std");

// Test-only supervisor adapted from Cottontail's tests/windows-job-launcher.zig.
// Assign the suspended launcher before it can create children, retain kernel
// handles, and prove the entire Job empty before fixtures can be removed.

const windows = std.os.windows;

const job_object_limit_kill_on_job_close: windows.DWORD = 0x00002000;
const job_object_basic_accounting_information: windows.DWORD = 1;
const job_object_extended_limit_information: windows.DWORD = 9;
const synchronize: windows.DWORD = 0x00100000;
const wait_object_0: windows.DWORD = 0;
const wait_timeout: windows.DWORD = 0x00000102;
const wait_failed: windows.DWORD = 0xffffffff;
const resume_thread_failed: windows.DWORD = 0xffffffff;
const error_already_exists: u16 = 183;

const IoCounters = extern struct {
    read_operation_count: u64 = 0,
    write_operation_count: u64 = 0,
    other_operation_count: u64 = 0,
    read_transfer_count: u64 = 0,
    write_transfer_count: u64 = 0,
    other_transfer_count: u64 = 0,
};

const BasicLimitInformation = extern struct {
    per_process_user_time_limit: i64 = 0,
    per_job_user_time_limit: i64 = 0,
    limit_flags: windows.DWORD = 0,
    minimum_working_set_size: usize = 0,
    maximum_working_set_size: usize = 0,
    active_process_limit: windows.DWORD = 0,
    affinity: usize = 0,
    priority_class: windows.DWORD = 0,
    scheduling_class: windows.DWORD = 0,
};

const ExtendedLimitInformation = extern struct {
    basic_limit_information: BasicLimitInformation = .{},
    io_info: IoCounters = .{},
    process_memory_limit: usize = 0,
    job_memory_limit: usize = 0,
    peak_process_memory_used: usize = 0,
    peak_job_memory_used: usize = 0,
};

const BasicAccountingInformation = extern struct {
    total_user_time: i64,
    total_kernel_time: i64,
    this_period_total_user_time: i64,
    this_period_total_kernel_time: i64,
    total_page_fault_count: windows.DWORD,
    total_processes: windows.DWORD,
    active_processes: windows.DWORD,
    total_terminated_processes: windows.DWORD,
};

extern "kernel32" fn CreateJobObjectW(
    job_attributes: ?*windows.SECURITY_ATTRIBUTES,
    name: windows.LPCWSTR,
) callconv(.winapi) ?windows.HANDLE;
extern "kernel32" fn SetInformationJobObject(
    job: windows.HANDLE,
    information_class: windows.DWORD,
    information: *const anyopaque,
    information_length: windows.DWORD,
) callconv(.winapi) windows.BOOL;
extern "kernel32" fn QueryInformationJobObject(
    job: windows.HANDLE,
    information_class: windows.DWORD,
    information: *anyopaque,
    information_length: windows.DWORD,
    return_length: ?*windows.DWORD,
) callconv(.winapi) windows.BOOL;
extern "kernel32" fn AssignProcessToJobObject(
    job: windows.HANDLE,
    process: windows.HANDLE,
) callconv(.winapi) windows.BOOL;
extern "kernel32" fn TerminateJobObject(
    job: windows.HANDLE,
    exit_code: windows.UINT,
) callconv(.winapi) windows.BOOL;
extern "kernel32" fn WaitForSingleObject(
    handle: windows.HANDLE,
    milliseconds: windows.DWORD,
) callconv(.winapi) windows.DWORD;
extern "kernel32" fn WaitForMultipleObjects(
    handle_count: windows.DWORD,
    handles: [*]const windows.HANDLE,
    wait_all: windows.BOOL,
    milliseconds: windows.DWORD,
) callconv(.winapi) windows.DWORD;
extern "kernel32" fn GetExitCodeProcess(
    process: windows.HANDLE,
    exit_code: *windows.DWORD,
) callconv(.winapi) windows.BOOL;
extern "kernel32" fn OpenProcess(
    desired_access: windows.DWORD,
    inherit_handle: windows.BOOL,
    process_id: windows.DWORD,
) callconv(.winapi) ?windows.HANDLE;
extern "kernel32" fn ResumeThread(thread: windows.HANDLE) callconv(.winapi) windows.DWORD;
extern "kernel32" fn ExitProcess(exit_code: windows.UINT) callconv(.winapi) noreturn;
extern "kernel32" fn GetProcessId(process: windows.HANDLE) callconv(.winapi) windows.DWORD;

fn validateJobName(name: []const u8) !void {
    const prefix = "Local\\ElectrobunLauncherTest-";
    if (!std.mem.startsWith(u8, name, prefix)) return error.InvalidJobName;
    if (name.len <= prefix.len or name.len > 120) return error.InvalidJobName;
    for (name[prefix.len..]) |byte| switch (byte) {
        'a'...'f', '0'...'9', '-' => {},
        else => return error.InvalidJobName,
    };
}

fn wideName(allocator: std.mem.Allocator, name: []const u8) ![:0]u16 {
    try validateJobName(name);
    return std.unicode.wtf8ToWtf16LeAllocZ(allocator, name);
}

fn configureKillOnClose(job: windows.HANDLE) !void {
    var limits: ExtendedLimitInformation = .{};
    limits.basic_limit_information.limit_flags = job_object_limit_kill_on_job_close;
    if (!SetInformationJobObject(
        job,
        job_object_extended_limit_information,
        &limits,
        @sizeOf(ExtendedLimitInformation),
    ).toBool()) return error.SetJobLimitsFailed;
}

fn activeProcessCount(job: windows.HANDLE) !windows.DWORD {
    var accounting: BasicAccountingInformation = undefined;
    if (!QueryInformationJobObject(
        job,
        job_object_basic_accounting_information,
        &accounting,
        @sizeOf(BasicAccountingInformation),
        null,
    ).toBool()) return error.QueryJobFailed;
    return accounting.active_processes;
}

fn waitForEmpty(job: windows.HANDLE, timeout_ms: windows.DWORD) !void {
    switch (WaitForSingleObject(job, timeout_ms)) {
        wait_object_0 => {},
        wait_timeout => return error.JobSettlementTimedOut,
        wait_failed => return error.JobWaitFailed,
        else => return error.UnexpectedJobWaitResult,
    }
    if (try activeProcessCount(job) != 0) return error.JobStillActive;
}

fn terminateAndProveEmpty(job: windows.HANDLE, timeout_ms: windows.DWORD) !void {
    if (!TerminateJobObject(job, 1).toBool()) return error.TerminateJobFailed;
    try waitForEmpty(job, timeout_ms);
}

pub fn main(init: std.process.Init) !void {
    const args = try init.minimal.args.toSlice(init.arena.allocator());
    if (args.len < 5) return error.InvalidArguments;
    const allocator = init.arena.allocator();
    const job_name = try wideName(allocator, args[1]);
    const parent_pid = try std.fmt.parseUnsigned(windows.DWORD, args[2], 10);
    const timeout_ms = try std.fmt.parseUnsigned(windows.DWORD, args[3], 10);
    if (parent_pid == 0) return error.InvalidParentProcess;
    if (timeout_ms == 0 or timeout_ms > 60_000) return error.InvalidTimeout;

    const parent = OpenProcess(synchronize, .FALSE, parent_pid) orelse
        return error.OpenParentProcessFailed;
    defer windows.CloseHandle(parent);

    const job = CreateJobObjectW(null, job_name.ptr) orelse
        return error.CreateJobFailed;
    defer windows.CloseHandle(job);
    if (@intFromEnum(windows.GetLastError()) == error_already_exists) {
        return error.JobNameAlreadyExists;
    }
    try configureKillOnClose(job);

    const child_argv: []const []const u8 = args[4..];
    var child = try std.process.spawn(init.io, .{
        .argv = child_argv,
        .cwd = .inherit,
        .environ_map = null,
        .stdin = .inherit,
        .stdout = .inherit,
        .stderr = .inherit,
        .start_suspended = true,
    });
    errdefer child.kill(init.io);

    if (!AssignProcessToJobObject(job, child.id.?).toBool()) {
        return error.AssignProcessToJobFailed;
    }
    const pid = GetProcessId(child.id.?);
    if (pid == 0) return error.ChildIdentityUnavailable;
    std.debug.print("[electrobun:test-job] {{\"event\":\"spawn\",\"pid\":{d}}}\n", .{pid});
    if (ResumeThread(child.thread_handle) == resume_thread_failed) {
        return error.ResumeThreadFailed;
    }

    const handles = [_]windows.HANDLE{ child.id.?, parent };
    const wait_result = WaitForMultipleObjects(handles.len, &handles, .FALSE, timeout_ms);
    if (wait_result == wait_failed) return error.ProcessWaitFailed;
    if (wait_result != wait_object_0 and wait_result != wait_object_0 + 1 and wait_result != wait_timeout) {
        return error.UnexpectedProcessWaitResult;
    }

    var child_exit_code: windows.DWORD = 1;
    if (wait_result == wait_object_0) {
        if (!GetExitCodeProcess(child.id.?, &child_exit_code).toBool()) {
            return error.GetChildExitCodeFailed;
        }
    }

    // Normal child exit can leave detached descendants alive. Terminate the
    // entire non-breakaway job and wait until Windows reports zero active
    // processes before allowing the test runner to reuse temp state.
    try terminateAndProveEmpty(job, 5_000);
    std.debug.print("[electrobun:test-job] {{\"event\":\"empty\",\"active\":0,\"timedOut\":{s}}}\n", .{if (wait_result == wait_timeout) "true" else "false"});

    windows.CloseHandle(child.thread_handle);
    windows.CloseHandle(child.id.?);
    child.id = null;

    if (wait_result == wait_object_0 + 1) ExitProcess(1);
    if (wait_result == wait_timeout) ExitProcess(124);
    ExitProcess(child_exit_code);
}
