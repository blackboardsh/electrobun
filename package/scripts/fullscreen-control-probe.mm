// Diagnostic controls for fullscreen failures on a native macOS runner.
// Stock mode uses AppKit alone. Wrapper mode calls the actual bundled dylib.
// A missed five-second deadline stays failed even if the subsequent bounded
// observation records a late completion; this probe never relaxes Kitchen.
#import <Cocoa/Cocoa.h>
#include <dlfcn.h>
#include <unistd.h>

using Callback = void (*)(uint32_t);
using Move = void (*)(uint32_t, double, double);
using Resize = void (*)(uint32_t, double, double, double, double);
using Key = void (*)(uint32_t, uint32_t, uint32_t, uint32_t, uint32_t);
using Create = NSWindow *(*)(uint32_t, double, double, double, double, uint32_t,
                            const char *, bool, double, double, Callback, Move,
                            Resize, Callback, Callback, Key, Callback);
using Show = void (*)(NSWindow *, bool);
using Set = void (*)(NSWindow *, bool);
using Get = bool (*)(NSWindow *);
using Close = void (*)(NSWindow *);

// Borderless hidden-titlebar windows must be able to become key, just as the
// production ElectrobunWindow subclass does. No fullscreen behavior is changed.
@interface ProbeWindow : NSWindow
@end
@implementation ProbeWindow
- (BOOL)canBecomeKeyWindow { return YES; }
- (BOOL)canBecomeMainWindow { return YES; }
@end

@interface FullscreenControl : NSObject <NSApplicationDelegate>
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) NSMutableArray *observers;
@property(nonatomic, assign) NSUInteger entered;
@property(nonatomic, assign) NSUInteger exited;
@property(nonatomic, assign) BOOL wrapper;
@property(nonatomic, assign) BOOL hidden;
@property(nonatomic, assign) Create createWindow;
@property(nonatomic, assign) Show showWindow;
@property(nonatomic, assign) Set setFullscreen;
@property(nonatomic, assign) Get getFullscreen;
@property(nonatomic, assign) Close closeWindow;
@end

@implementation FullscreenControl
- (void)trace:(const char *)event {
  NSWindow *window = self.window;
  fprintf(stderr,
          "[fullscreen-control] pid=%d t=%.6f mode=%s titlebar=%s event=%s "
          "style=0x%lx fullscreen=%d entered=%lu exited=%lu visible=%d "
          "key=%d active=%d reduceMotion=%d presentation=0x%lx "
          "frame=%s screen=%s runloop=%s\n",
          getpid(), NSProcessInfo.processInfo.systemUptime,
          self.wrapper ? "wrapper" : "stock", self.hidden ? "hidden" : "normal",
          event, (unsigned long)window.styleMask,
          (window.styleMask & NSWindowStyleMaskFullScreen) != 0,
          (unsigned long)self.entered, (unsigned long)self.exited,
          (int)window.visible, (int)window.keyWindow, (int)NSApp.active,
          (int)NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion,
          (unsigned long)NSApp.currentSystemPresentationOptions,
          NSStringFromRect(window.frame).UTF8String,
          NSStringFromRect(window.screen.frame).UTF8String,
          (NSRunLoop.currentRunLoop.currentMode ?: @"none").UTF8String);
}

- (void)observeNotifications {
  self.observers = [NSMutableArray new];
  NSArray *names = @[
    NSWindowWillEnterFullScreenNotification, NSWindowDidEnterFullScreenNotification,
    NSWindowWillExitFullScreenNotification, NSWindowDidExitFullScreenNotification,
  ];
  NSArray *events = @[@"will-enter", @"did-enter", @"will-exit", @"did-exit"];
  for (NSUInteger i = 0; i < names.count; ++i) {
    NSString *name = names[i];
    NSString *event = events[i];
    id observer = [NSNotificationCenter.defaultCenter
        addObserverForName:name object:self.window queue:nil
        usingBlock:^(NSNotification *) {
          if ([name isEqual:NSWindowDidEnterFullScreenNotification]) self.entered++;
          if ([name isEqual:NSWindowDidExitFullScreenNotification]) self.exited++;
          [self trace:event.UTF8String];
        }];
    [self.observers addObject:observer];
  }
  id observer = [NSWorkspace.sharedWorkspace.notificationCenter
      addObserverForName:NSWorkspaceActiveSpaceDidChangeNotification
      object:nil queue:NSOperationQueue.mainQueue
      usingBlock:^(NSNotification *) { [self trace:"active-space-changed"]; }];
  [self.observers addObject:observer];
}

- (BOOL)waitFor:(BOOL (^)(void))predicate phase:(const char *)phase
       started:(NSTimeInterval)started {
  while (true) {
    __block BOOL done;
    dispatch_sync(dispatch_get_main_queue(), ^{ done = predicate(); });
    NSTimeInterval elapsed = NSProcessInfo.processInfo.systemUptime - started;
    if (done && elapsed <= 5.0) {
      fprintf(stderr, "[fullscreen-control] pid=%d event=phase-passed phase=%s elapsed=%.3f\n",
              getpid(), phase, elapsed);
      return YES;
    }
    if (elapsed >= 5.0) {
      fprintf(stderr, "[fullscreen-control] pid=%d event=deadline-failed phase=%s deadline=5 elapsed=%.3f\n",
              getpid(), phase, elapsed);
      return NO;
    }
    usleep(25000);
  }
}

- (void)finish:(BOOL)passed {
  if (!passed) {
    // Preserve the failed result while observing whether AppKit ever completes.
    NSTimeInterval started = NSProcessInfo.processInfo.systemUptime;
    while (NSProcessInfo.processInfo.systemUptime - started < 20.0) {
      dispatch_sync(dispatch_get_main_queue(), ^{ [self trace:"after-deadline"]; });
      usleep(500000);
    }
  }
  dispatch_sync(dispatch_get_main_queue(), ^{
    [self trace:passed ? "passed" : "failed"];
    if (self.wrapper) self.closeWindow(self.window);
    else [self.window close];
  });
  exit(passed ? 0 : 1);
}

- (void)runControl {
  @autoreleasepool {
    const uint32_t style = NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable |
        NSWindowStyleMaskResizable | (self.hidden ? NSWindowStyleMaskFullSizeContentView : NSWindowStyleMaskTitled);
    if (self.wrapper) {
      NSWindow *window = self.createWindow(1, 100, 100, 640, 480, style,
          self.hidden ? "hidden" : "default", false, 0, 0,
          nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr);
      dispatch_sync(dispatch_get_main_queue(), ^{
        self.window = window;
        [self observeNotifications];
      });
      self.showWindow(window, true);
    } else {
      dispatch_sync(dispatch_get_main_queue(), ^{
        self.window = [[ProbeWindow alloc] initWithContentRect:NSMakeRect(100, 100, 640, 480)
            styleMask:style backing:NSBackingStoreBuffered defer:NO];
        self.window.releasedWhenClosed = NO;
        self.window.collectionBehavior = NSWindowCollectionBehaviorFullScreenPrimary;
        self.window.title = @"Stock AppKit fullscreen control";
        [self observeNotifications];
        [self.window makeKeyAndOrderFront:nil];
        [NSApp activateIgnoringOtherApps:YES];
      });
    }
    usleep(500000);
    NSTimeInterval enterStarted = NSProcessInfo.processInfo.systemUptime;
    dispatch_sync(dispatch_get_main_queue(), ^{
      [self trace:"request-enter"];
    });
    if (self.wrapper) self.setFullscreen(self.window, true);
    else dispatch_sync(dispatch_get_main_queue(), ^{ [self.window toggleFullScreen:nil]; });
    BOOL entered = [self waitFor:^BOOL {
      // Neither control reverses an in-flight entry. Kitchen separately covers
      // that path; these controls isolate whether AppKit completes entry at all.
      return self.entered > 0;
    } phase:"entry-completion" started:enterStarted];
    if (!entered) { [self finish:NO]; return; }
    NSTimeInterval exitStarted = NSProcessInfo.processInfo.systemUptime;
    dispatch_sync(dispatch_get_main_queue(), ^{
      [self trace:"request-exit"];
    });
    if (self.wrapper) self.setFullscreen(self.window, false);
    else dispatch_sync(dispatch_get_main_queue(), ^{ [self.window toggleFullScreen:nil]; });
    BOOL exited = [self waitFor:^BOOL {
      BOOL fullscreen = self.wrapper ? self.getFullscreen(self.window)
          : (self.window.styleMask & NSWindowStyleMaskFullScreen) != 0;
      return self.entered > 0 && self.exited > 0 && !fullscreen;
    } phase:"exit-completion" started:exitStarted];
    [self finish:exited];
  }
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  (void)notification;
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{ [self runControl]; });
}
@end

int main(int argc, char **argv) {
  @autoreleasepool {
    if (argc < 3 || (strcmp(argv[1], "stock") && strcmp(argv[1], "wrapper")) ||
        (strcmp(argv[2], "normal") && strcmp(argv[2], "hidden"))) {
      fprintf(stderr, "Usage: fullscreen-control-probe <stock|wrapper> <normal|hidden> [wrapper-dylib]\n");
      return 2;
    }
    // Independent process bound if an AppKit synchronous call itself wedges.
    alarm(45);
    FullscreenControl *control = [FullscreenControl new];
    control.wrapper = !strcmp(argv[1], "wrapper");
    control.hidden = !strcmp(argv[2], "hidden");
    if (control.wrapper) {
      if (argc != 4) return 2;
      void *library = dlopen(argv[3], RTLD_NOW | RTLD_LOCAL);
      if (!library) { fprintf(stderr, "dlopen: %s\n", dlerror()); return 2; }
      control.createWindow = (Create)dlsym(library, "createWindowWithFrameAndStyleFromWorker");
      control.showWindow = (Show)dlsym(library, "showWindow");
      control.setFullscreen = (Set)dlsym(library, "setWindowFullScreen");
      control.getFullscreen = (Get)dlsym(library, "isWindowFullScreen");
      control.closeWindow = (Close)dlsym(library, "closeWindow");
      if (!control.createWindow || !control.showWindow || !control.setFullscreen ||
          !control.getFullscreen || !control.closeWindow) return 2;
    }
    fprintf(stderr, "[fullscreen-control] pid=%d event=start arch=%s os=%s\n", getpid(),
#if defined(__x86_64__)
            "x86_64",
#elif defined(__aarch64__)
            "arm64",
#else
            "unknown",
#endif
            NSProcessInfo.processInfo.operatingSystemVersionString.UTF8String);
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    NSApp.delegate = control;
    [NSApp run];
  }
  return 2;
}
