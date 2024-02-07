pub const ZigSchema = struct { //
    pub const requests = struct { //
        pub const decideNavigation = struct { //
            pub const args = struct {
                url: []const u8,
            };
            pub const returns = struct {
                allow: bool,
            };
        };
    };
};

pub const BunSchema = struct {
    pub const requests = struct {
        pub const createWindow = struct {
            pub const args = struct {
                id: u32, // window id
                title: []const u8, // | null,
                url: ?[]const u8, // | null,
                html: ?[]const u8, // | null,
                width: f64, // | null,
                height: f64, // | null,
                x: f64, // | null,
                y: f64, // | null,
            };
        };
        pub const setTitle = struct { //
            pub const args = struct {
                winId: u32,
                title: []const u8,
            };
        };
    };
};

// todo: can we replace this with a compile-time function
pub const Handlers = struct {
    createWindow: fn (args: BunSchema.requests.createWindow.args) void,
    setTitle: fn (args: BunSchema.requests.setTitle.args) void,
};

pub const Senders = struct {
    decideNavigation: fn (args: ZigSchema.requests.decideNavigation.args) ZigSchema.requests.decideNavigation.returns,
};
