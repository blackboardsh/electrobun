pub const ZigSchema = struct { //
    pub const requests = struct { //
        pub const decideNavigation = struct { //
            pub const params = struct {
                webviewId: u32,
                url: []const u8,
            };
            pub const response = struct {
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
            pub const response = void;
        };

        pub const setContentView = struct {
            pub const params = struct {
                windowId: u32,
                webviewId: u32,
            };
            pub const response = void;
        };
        pub const setTitle = struct { //
            pub const params = struct {
                // todo: be consistent about winId vs windowId
                winId: u32,
                title: []const u8,
            };
            pub const response = void;
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
            pub const response = void;
        };

        pub const loadURL = struct {
            pub const params = struct {
                webviewId: u32,
                url: []const u8,
            };
            pub const response = void;
        };

        pub const loadHTML = struct {
            pub const params = struct {
                webviewId: u32,
                html: []const u8,
            };
            pub const response = void;
        };
    };
};
pub const RequestResult = struct { errorMsg: ?[]const u8, payload: ?RequestResponseType };
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
    decideNavigation: fn (params: ZigSchema.requests.decideNavigation.params) ZigSchema.requests.decideNavigation.response,
};

pub const RequestResponseType = union(enum) {
    CreateWindowResponse: BunSchema.requests.createWindow.response,
    CreateWebviewResponse: BunSchema.requests.createWebview.response,
    SetTitleResponse: BunSchema.requests.setTitle.response,
    SetContentViewResponse: BunSchema.requests.setContentView.response,
    LoadURLResponse: BunSchema.requests.loadURL.response,
    LoadHTMLResponse: BunSchema.requests.loadHTML.response,
    DecideNavigationResponse: ZigSchema.requests.decideNavigation.response,
};

pub const ResponsePayloadType = union(enum) {
    DecideNavigationResponse: ZigSchema.requests.decideNavigation.response,
    // SomeOtherMethodResponse: ZigSchema.requests.someOtherMethod.response,
};
