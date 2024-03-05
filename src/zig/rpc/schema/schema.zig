pub const ZigSchema = struct { //
    pub const requests = struct { //
        pub const decideNavigation = struct { //
            pub const params = struct {
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
            pub const params = struct {
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
            pub const params = struct {
                windowId: u32,
                webviewId: u32,
            };
            pub const returns = void;
        };
        pub const setTitle = struct { //
            pub const params = struct {
                // todo: be consistent about winId vs windowId
                winId: u32,
                title: []const u8,
            };
            pub const returns = void;
        };

        pub const createWebview = struct {
            pub const params = struct {
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
            pub const params = struct {
                webviewId: u32,
                url: []const u8,
            };
            pub const returns = void;
        };

        pub const loadHTML = struct {
            pub const params = struct {
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
    createWindow: fn (params: BunSchema.requests.createWindow.params) RequestResult,
    createWebview: fn (params: BunSchema.requests.createWebview.params) RequestResult,
    setTitle: fn (params: BunSchema.requests.setTitle.params) RequestResult,
    setContentView: fn (params: BunSchema.requests.setContentView.params) RequestResult,
    loadURL: fn (params: BunSchema.requests.loadURL.params) RequestResult,
    loadHTML: fn (params: BunSchema.requests.loadHTML.params) RequestResult,
};

pub const Requests = struct {
    decideNavigation: fn (params: ZigSchema.requests.decideNavigation.params) ZigSchema.requests.decideNavigation.returns,
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
