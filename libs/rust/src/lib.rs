use wry::{
    application::{
        event_loop::{EventLoop, ControlFlow},
        window::WindowBuilder,
        event::{Event, WindowEvent},
    },
    webview::WebViewBuilder,
};

#[no_mangle]
pub extern "C" fn create_webview(url: *const std::os::raw::c_char) {
    let url = unsafe {
        assert!(!url.is_null());
        std::ffi::CStr::from_ptr(url).to_string_lossy().into_owned()
    };

    let event_loop = EventLoop::new();
    let window = WindowBuilder::new().build(&event_loop).unwrap();
    let _webview = WebViewBuilder::new(window)
        .unwrap()
        .with_url(&url)
        .unwrap()
        .build()
        .unwrap();

    std::thread::spawn(move || {
        

        event_loop.run(move |event, _, control_flow| {
            *control_flow = ControlFlow::Wait;

            if let Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } = event {
                *control_flow = ControlFlow::Exit;
            }
        });
    });
}

