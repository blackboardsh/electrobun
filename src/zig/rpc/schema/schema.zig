// Zig sends to Bun
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

        pub const sendSyncRequest = struct { //
            pub const params = struct {
                webviewId: u32,
                request: []const u8,
            };
            pub const response = struct {
                payload: []const u8,
            };
        };
        // Note: this should be a message not a request
        // because we don't need a response
        pub const log = struct {
            pub const params = struct {
                msg: []const u8,
            };
            pub const response = struct {
                success: bool,
            };
        };
    };
};

// Bun sends to Zig
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

        pub const addWebviewToWindow = struct {
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
    addWebviewToWindow: fn (params: BunSchema.requests.addWebviewToWindow.params) RequestResult,
    loadURL: fn (params: BunSchema.requests.loadURL.params) RequestResult,
    loadHTML: fn (params: BunSchema.requests.loadHTML.params) RequestResult,
};

pub const Requests = struct {
    decideNavigation: fn (params: ZigSchema.requests.decideNavigation.params) ZigSchema.requests.decideNavigation.response,
    sendSyncRequest: fn (params: ZigSchema.requests.sendSyncRequest.params) ZigSchema.requests.sendSyncRequest.response,
    log: fn (params: ZigSchema.requests.log.params) ZigSchema.requests.log.response,
};

pub const RequestResponseType = union(enum) {
    CreateWindowResponse: BunSchema.requests.createWindow.response,
    CreateWebviewResponse: BunSchema.requests.createWebview.response,
    SetTitleResponse: BunSchema.requests.setTitle.response,
    addWebviewToWindowResponse: BunSchema.requests.addWebviewToWindow.response,
    LoadURLResponse: BunSchema.requests.loadURL.response,
    LoadHTMLResponse: BunSchema.requests.loadHTML.response,
    DecideNavigationResponse: ZigSchema.requests.decideNavigation.response,
    SendSyncRequestResponse: ZigSchema.requests.sendSyncRequest.response,
};

// todo: is this still used anywhere
pub const ResponsePayloadType = union(enum) {
    DecideNavigationResponse: ZigSchema.requests.decideNavigation.response,
    // SomeOtherMethodResponse: ZigSchema.requests.someOtherMethod.response,
};

// browser -> zig schema
pub const FromBrowserHandlers = struct {
    webviewTagInit: fn (params: BrowserSchema.requests.webviewTagInit.params) RequestResult,
    webviewTagResize: fn (params: BrowserSchema.messages.webviewTagResize) RequestResult,
};

// Browser sends to Zig
pub const BrowserSchema = struct { //
    pub const requests = struct { //
        pub const webviewTagInit = struct {
            pub const params = struct {
                id: u32,
                url: ?[]const u8,
                html: ?[]const u8,
                preload: ?[]const u8,
                frame: struct {
                    width: f64,
                    height: f64,
                    x: f64,
                    y: f64,
                },
            };
        };
    };
    pub const messages = struct {
        pub const webviewTagResize = struct {
            id: u32,
            frame: struct {
                width: f64,
                height: f64,
                x: f64,
                y: f64,
            },
        };
    };
};
