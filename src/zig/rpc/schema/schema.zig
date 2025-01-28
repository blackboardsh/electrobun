// Zig sends to Bun
pub const ZigSchema = struct { //
    pub const requests = struct { //
        pub const decideNavigation = struct { //
            pub const params = struct {
                webviewId: u32,
                url: []const u8,
            };
            pub const response = struct {
                success: bool,
            };
        };

        // pub const sendSyncRequest = struct { //
        //     pub const params = struct {
        //         webviewId: u32,
        //         request: []const u8,
        //     };
        //     pub const response = struct {
        //         payload: ?[]const u8,
        //     };
        // };
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
        // Note: this should be a message not a request
        // no need to block the thread we don't need a response.
        pub const trayEvent = struct {
            pub const params = struct {
                id: u32,
                action: []const u8,
            };
            pub const response = struct {
                success: bool,
            };
        };
        // Note: this should be a message not a request
        // no need to block the thread we don't need a response.
        pub const applicationMenuEvent = struct {
            pub const params = struct {
                action: []const u8,
            };
            pub const response = struct {
                success: bool,
            };
        };
        // Note: this should be a message not a request
        // no need to block the thread we don't need a response.
        pub const contextMenuEvent = struct {
            pub const params = struct {
                action: []const u8,
            };
            pub const response = struct {
                success: bool,
            };
        };
        // Note: this should be a message not a request
        // no need to block the thread we don't need a response.
        pub const webviewEvent = struct {
            pub const params = struct {
                id: u32,
                eventName: []const u8,
                detail: []const u8,
            };
            pub const response = struct {
                success: bool,
            };
        };
        pub const windowClose = struct {
            pub const params = struct {
                id: u32,
            };
            pub const response = struct {
                success: bool,
            };
        };
        pub const windowMove = struct {
            pub const params = struct {
                id: u32,
                x: f64,
                y: f64,
            };
            pub const response = struct {
                success: bool,
            };
        };
        pub const windowResize = struct {
            pub const params = struct {
                id: u32,
                x: f64,
                y: f64,
                width: f64,
                height: f64,
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
                url: []const u8,
                frame: struct {
                    width: f64,
                    height: f64,
                    x: f64,
                    y: f64,
                },
                styleMask: struct {
                    Borderless: bool,
                    Titled: bool,
                    Closable: bool,
                    Miniaturizable: bool,
                    Resizable: bool,
                    UnifiedTitleAndToolbar: bool,
                    FullScreen: bool,
                    FullSizeContentView: bool,
                    UtilityWindow: bool,
                    DocModalWindow: bool,
                    NonactivatingPanel: bool,
                    HUDWindow: bool,
                },
                titleBarStyle: []const u8,
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
        pub const closeWindow = struct { //
            pub const params = struct {
                // todo: be consistent about winId vs windowId
                winId: u32,
            };
            pub const response = void;
        };

        pub const createWebview = struct {
            pub const params = struct {
                id: u32,
                windowId: u32,
                renderer: []const u8,
                rpcPort: u32,
                secretKey: []const u8,
                hostWebviewId: ?u32,
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

        // fs
        pub const moveToTrash = struct {
            pub const params = struct {
                path: []const u8,
            };
            pub const response = bool;
        };
        pub const showItemInFolder = struct {
            pub const params = struct {
                path: []const u8,
            };
            pub const response = bool;
        };
        pub const openFileDialog = struct {
            pub const params = struct {
                startingFolder: []const u8,
                allowedFileTypes: []const u8,
                canChooseFiles: bool,
                canChooseDirectory: bool,
                allowsMultipleSelection: bool,
            };
            pub const response = []const u8;
        };

        // system tray and menu
        pub const createTray = struct {
            pub const params = struct { id: u32, title: []const u8, image: []const u8, template: bool, width: u32, height: u32 };
            pub const response = void;
        };
        pub const setTrayTitle = struct {
            pub const params = struct {
                id: u32,
                title: []const u8,
            };
            pub const response = void;
        };
        pub const setTrayImage = struct {
            pub const params = struct {
                id: u32,
                image: []const u8,
            };
            pub const response = void;
        };
        pub const setTrayMenu = struct {
            pub const params = struct {
                id: u32,
                menuConfig: []const u8,
            };
            pub const response = void;
        };
        pub const setApplicationMenu = struct {
            pub const params = struct {
                menuConfig: []const u8,
            };
            pub const response = void;
        };
        pub const showContextMenu = struct {
            pub const params = struct {
                menuConfig: []const u8,
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
    closeWindow: fn (params: BunSchema.requests.closeWindow.params) RequestResult,
    loadURL: fn (params: BunSchema.requests.loadURL.params) RequestResult,
    moveToTrash: fn (params: BunSchema.requests.moveToTrash.params) RequestResult,
    showItemInFolder: fn (params: BunSchema.requests.showItemInFolder.params) RequestResult,
    openFileDialog: fn (params: BunSchema.requests.openFileDialog.params) RequestResult,
    createTray: fn (params: BunSchema.requests.createTray.params) RequestResult,
    setTrayTitle: fn (params: BunSchema.requests.setTrayTitle.params) RequestResult,
    setTrayImage: fn (params: BunSchema.requests.setTrayImage.params) RequestResult,
    setTrayMenu: fn (params: BunSchema.requests.setTrayMenu.params) RequestResult,
    setApplicationMenu: fn (params: BunSchema.requests.setApplicationMenu.params) RequestResult,
    showContextMenu: fn (params: BunSchema.requests.showContextMenu.params) RequestResult,
};

pub const Requests = struct {
    // decideNavigation: fn (params: ZigSchema.requests.decideNavigation.params) void,
    // sendSyncRequest: fn (params: ZigSchema.requests.sendSyncRequest.params) void,
    log: fn (params: ZigSchema.requests.log.params) void,
    trayEvent: fn (params: ZigSchema.requests.trayEvent.params) void,
    applicationMenuEvent: fn (params: ZigSchema.requests.applicationMenuEvent.params) void,
    contextMenuEvent: fn (params: ZigSchema.requests.contextMenuEvent.params) void,
    webviewEvent: fn (params: ZigSchema.requests.webviewEvent.params) void,
    windowClose: fn (params: ZigSchema.requests.windowClose.params) void,
    windowMove: fn (params: ZigSchema.requests.windowMove.params) void,
    windowResize: fn (params: ZigSchema.requests.windowResize.params) void,
};

// todo: currently the the keys will be a key of the payload struct because of how unions work in zig.
// so it'll be payload = .{ webviewTagCanGoBackResponse: true} since the payload in schema is defined as bool.
// rather than payload = true;
pub const RequestResponseType = union(enum) {
    CreateWindowResponse: BunSchema.requests.createWindow.response,
    CreateWebviewResponse: BunSchema.requests.createWebview.response,
    SetTitleResponse: BunSchema.requests.setTitle.response,
    closeWindowResponse: BunSchema.requests.closeWindow.response,
    LoadURLResponse: BunSchema.requests.loadURL.response,
    moveToTrashResponse: BunSchema.requests.moveToTrash.response,
    showItemInFolderResponse: BunSchema.requests.showItemInFolder.response,
    openFileDialogResponse: BunSchema.requests.openFileDialog.response,

    createTray: BunSchema.requests.createTray.response,
    setTrayTitle: BunSchema.requests.setTrayTitle.response,
    setTrayImage: BunSchema.requests.setTrayImage.response,
    setTrayMenu: BunSchema.requests.setTrayMenu.response,

    setApplicationMenu: BunSchema.requests.setApplicationMenu.response,
    showContextMenu: BunSchema.requests.showContextMenu.response,

    webviewTagCanGoBackResponse: BrowserSchema.requests.webviewTagCanGoBack.response,
    webviewTagCanGoForwardResponse: BrowserSchema.requests.webviewTagCanGoForward.response,
};

// todo: is this still used anywhere
pub const ResponsePayloadType = union(enum) {
    // DecideNavigationResponse: ZigSchema.requests.decideNavigation.response,
    // SomeOtherMethodResponse: ZigSchema.requests.someOtherMethod.response,
};

// browser -> zig schema
pub const FromBrowserHandlers = struct {
    // requests
    webviewTagCanGoBack: fn (params: BrowserSchema.requests.webviewTagCanGoBack.params) RequestResult,
    webviewTagCanGoForward: fn (params: BrowserSchema.requests.webviewTagCanGoForward.params) RequestResult,
    webviewTagCallAsyncJavaScript: fn (params: BrowserSchema.requests.webviewTagCallAsyncJavaScript.params) RequestResult,
    // messages
    webviewTagResize: fn (params: BrowserSchema.messages.webviewTagResize) RequestResult,
    webviewTagUpdateSrc: fn (params: BrowserSchema.messages.webviewTagUpdateSrc) RequestResult,
    webviewTagUpdateHtml: fn (params: BrowserSchema.messages.webviewTagUpdateHtml) RequestResult,
    webviewTagUpdatePreload: fn (params: BrowserSchema.messages.webviewTagUpdatePreload) RequestResult,
    webviewTagGoBack: fn (params: BrowserSchema.messages.webviewTagGoBack) RequestResult,
    webviewTagGoForward: fn (params: BrowserSchema.messages.webviewTagGoForward) RequestResult,
    webviewTagReload: fn (params: BrowserSchema.messages.webviewTagReload) RequestResult,
    webviewTagRemove: fn (params: BrowserSchema.messages.webviewTagRemove) RequestResult,
    startWindowMove: fn (params: BrowserSchema.messages.startWindowMove) RequestResult,
    stopWindowMove: fn (params: BrowserSchema.messages.stopWindowMove) RequestResult,
    webviewTagSetTransparent: fn (params: BrowserSchema.messages.webviewTagSetTransparent) RequestResult,
    webviewTagToggleMirroring: fn (params: BrowserSchema.messages.webviewTagToggleMirroring) RequestResult,
    webviewTagSetPassthrough: fn (params: BrowserSchema.messages.webviewTagSetPassthrough) RequestResult,
    webviewTagSetHidden: fn (params: BrowserSchema.messages.webviewTagSetHidden) RequestResult,
    webviewEvent: fn (params: BrowserSchema.messages.webviewEvent) RequestResult,
};

// Browser sends to Zig
pub const BrowserSchema = struct { //
    pub const requests = struct { //
        pub const webviewTagCanGoBack = struct {
            pub const params = struct { id: u32 };
            pub const response = bool;
        };
        pub const webviewTagCanGoForward = struct {
            pub const params = struct { id: u32 };
            pub const response = bool;
        };
        // todo: maybe this should be a message
        pub const webviewTagCallAsyncJavaScript = struct {
            pub const params = struct { messageId: []const u8, webviewId: u32, hostWebviewId: u32, script: []const u8 };
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
            masks: []const u8,
        };
        pub const webviewTagUpdateSrc = struct {
            id: u32,
            url: []const u8,
        };
        pub const webviewTagUpdateHtml = struct {
            id: u32,
            html: []const u8,
        };
        pub const webviewTagUpdatePreload = struct {
            id: u32,
            preload: []const u8,
        };
        pub const webviewTagGoBack = struct { id: u32 };
        pub const webviewTagGoForward = struct { id: u32 };
        pub const webviewTagReload = struct { id: u32 };
        pub const webviewTagRemove = struct { id: u32 };
        pub const startWindowMove = struct { id: u32 };
        pub const stopWindowMove = struct { id: u32 };
        pub const webviewTagSetTransparent = struct { id: u32, transparent: bool };
        pub const webviewTagToggleMirroring = struct { id: u32, enable: bool };
        pub const webviewTagSetPassthrough = struct { id: u32, enablePassthrough: bool };
        pub const webviewTagSetHidden = struct { id: u32, hidden: bool };
        pub const webviewEvent = struct {
            id: u32,
            eventName: []const u8,
            detail: []const u8,
        };
    };
};
