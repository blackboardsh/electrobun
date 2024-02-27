pub const ZigSchema = struct { //
    pub const requests = struct { //
        pub const decideNavigation = struct { //
            pub const args = struct {
                webviewId: u32,
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
            pub const returns = void;
        };

        pub const setContentView = struct {
            pub const args = struct {
                windowId: u32,
                webviewId: u32,
            };
            pub const returns = void;
        };
        pub const setTitle = struct { //
            pub const args = struct {
                // todo: be consistent about winId vs windowId
                winId: u32,
                title: []const u8,
            };
            pub const returns = void;
        };

        pub const createWebview = struct {
            pub const args = struct {
                id: u32,
                url: ?[]const u8,
                html: ?[]const u8,
                preload: ?[]const u8,
                frame: struct { //
                    width: f64,
                    height: f64,
                    x: f64,
                    y: f64,
                },
            };
            pub const returns = void;
        };

        pub const loadURL = struct {
            pub const args = struct {
                webviewId: u32,
                url: []const u8,
            };
            pub const returns = void;
        };

        pub const loadHTML = struct {
            pub const args = struct {
                webviewId: u32,
                html: []const u8,
            };
            pub const returns = void;
        };
    };
};
pub const RequestResult = struct { errorMsg: ?[]const u8, payload: ?RequestReturnsType };
// todo: can we replace this with a compile-time function
pub const Handlers = struct {
    createWindow: fn (args: BunSchema.requests.createWindow.args) RequestResult,
    createWebview: fn (args: BunSchema.requests.createWebview.args) RequestResult,
    setTitle: fn (args: BunSchema.requests.setTitle.args) RequestResult,
    setContentView: fn (args: BunSchema.requests.setContentView.args) RequestResult,
    loadURL: fn (args: BunSchema.requests.loadURL.args) RequestResult,
    loadHTML: fn (args: BunSchema.requests.loadHTML.args) RequestResult,
};

pub const Requests = struct {
    decideNavigation: fn (args: ZigSchema.requests.decideNavigation.args) ZigSchema.requests.decideNavigation.returns,
};

pub const RequestReturnsType = union(enum) {
    CreateWindowReturns: BunSchema.requests.createWindow.returns,
    CreateWebviewReturns: BunSchema.requests.createWebview.returns,
    SetTitleReturns: BunSchema.requests.setTitle.returns,
    SetContentViewReturns: BunSchema.requests.setContentView.returns,
    LoadURLReturns: BunSchema.requests.loadURL.returns,
    LoadHTMLReturns: BunSchema.requests.loadHTML.returns,
    DecideNavigationReturns: ZigSchema.requests.decideNavigation.returns,
};

pub const ResponsePayloadType = union(enum) {
    DecideNavigationReturns: ZigSchema.requests.decideNavigation.returns,
    // SomeOtherMethodReturns: ZigSchema.requests.someOtherMethod.returns,
};
