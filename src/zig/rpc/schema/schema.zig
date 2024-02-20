pub const ZigSchema = struct { //
    pub const requests = struct { //
        pub const decideNavigation = struct { //
            pub const args = struct {
                url: [*:0]const u8,
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
                id: u32,
                title: []const u8,
                url: ?[]const u8,
                html: ?[]const u8, //
                frame: struct {
                    width: f64,
                    height: f64,
                    x: f64,
                    y: f64,
                },
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

pub const Requests = struct {
    decideNavigation: fn (args: ZigSchema.requests.decideNavigation.args) ZigSchema.requests.decideNavigation.returns,
};

pub const PayloadType = union(enum) {
    DecideNavigationReturns: ZigSchema.requests.decideNavigation.returns,
    // SomeOtherMethodReturns: ZigSchema.requests.someOtherMethod.returns,
};
