#import <AppKit/AppKit.h>
#import <stdlib.h>
#import <string.h>
#import <unistd.h>

@interface ElectrobunInstallerProgressUI : NSObject <NSWindowDelegate>
@property(nonatomic, strong) NSPanel *panel;
@property(nonatomic, strong) NSTextField *instructionLabel;
@property(nonatomic, strong) NSTextField *phaseLabel;
@property(nonatomic, strong) NSProgressIndicator *progressIndicator;
@property(nonatomic, strong) NSButton *closeButton;
@property(nonatomic) BOOL terminal;
@property(nonatomic) BOOL dismissed;
@end

static void electrobun_pump_installer_events(NSDate *deadline) {
    NSEvent *event;
    while ((event = [NSApp nextEventMatchingMask:NSEventMaskAny
                                        untilDate:deadline
                                           inMode:NSDefaultRunLoopMode
                                          dequeue:YES]) != nil) {
        [NSApp sendEvent:event];
        deadline = [NSDate date];
    }
    [NSApp updateWindows];
}

@implementation ElectrobunInstallerProgressUI

- (void)dismiss:(id)sender {
    (void)sender;
    self.dismissed = YES;
    [self.panel orderOut:nil];
}

- (BOOL)windowShouldClose:(NSWindow *)sender {
    (void)sender;
    if (!self.terminal) {
        NSBeep();
        return NO;
    }
    self.dismissed = YES;
    return YES;
}

@end

static ElectrobunInstallerProgressUI *electrobun_macos_installer_ui(
    void *handle) {
    return (__bridge ElectrobunInstallerProgressUI *)handle;
}

void *electrobun_macos_installer_ui_start(const char *app_name_utf8) {
    @autoreleasepool {
        if (![NSThread isMainThread] || app_name_utf8 == NULL) return NULL;

        NSString *appName = [NSString stringWithUTF8String:app_name_utf8];
        if (appName == nil || appName.length == 0) return NULL;

        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

        ElectrobunInstallerProgressUI *ui =
            [[ElectrobunInstallerProgressUI alloc] init];
        NSPanel *panel = [[NSPanel alloc]
            initWithContentRect:NSMakeRect(0, 0, 460, 190)
                      styleMask:(NSWindowStyleMaskTitled |
                                 NSWindowStyleMaskClosable)
                        backing:NSBackingStoreBuffered
                          defer:NO];
        panel.title = [NSString stringWithFormat:@"%@ Setup", appName];
        panel.releasedWhenClosed = NO;
        panel.hidesOnDeactivate = NO;
        panel.delegate = ui;
        ui.panel = panel;

        NSView *content = panel.contentView;
        NSTextField *instruction =
            [NSTextField labelWithString:
                [NSString stringWithFormat:@"Installing %@", appName]];
        instruction.font = [NSFont systemFontOfSize:17
                                             weight:NSFontWeightSemibold];
        instruction.translatesAutoresizingMaskIntoConstraints = NO;
        ui.instructionLabel = instruction;
        [content addSubview:instruction];

        NSTextField *phase =
            [NSTextField labelWithString:@"Preparing installation..."];
        phase.textColor = NSColor.secondaryLabelColor;
        phase.lineBreakMode = NSLineBreakByTruncatingTail;
        phase.translatesAutoresizingMaskIntoConstraints = NO;
        ui.phaseLabel = phase;
        [content addSubview:phase];

        NSProgressIndicator *progress = [[NSProgressIndicator alloc] init];
        progress.style = NSProgressIndicatorStyleBar;
        progress.indeterminate = YES;
        progress.minValue = 0;
        progress.maxValue = 100;
        progress.translatesAutoresizingMaskIntoConstraints = NO;
        [progress startAnimation:nil];
        ui.progressIndicator = progress;
        [content addSubview:progress];

        NSButton *closeButton = [NSButton buttonWithTitle:@"Close"
                                                  target:ui
                                                  action:@selector(dismiss:)];
        closeButton.bezelStyle = NSBezelStyleRounded;
        closeButton.keyEquivalent = @"\r";
        closeButton.hidden = YES;
        closeButton.translatesAutoresizingMaskIntoConstraints = NO;
        ui.closeButton = closeButton;
        [content addSubview:closeButton];

        [NSLayoutConstraint activateConstraints:@[
            [instruction.leadingAnchor constraintEqualToAnchor:content.leadingAnchor
                                                      constant:24],
            [instruction.trailingAnchor constraintEqualToAnchor:content.trailingAnchor
                                                       constant:-24],
            [instruction.topAnchor constraintEqualToAnchor:content.topAnchor
                                                  constant:24],
            [phase.leadingAnchor constraintEqualToAnchor:instruction.leadingAnchor],
            [phase.trailingAnchor constraintEqualToAnchor:instruction.trailingAnchor],
            [phase.topAnchor constraintEqualToAnchor:instruction.bottomAnchor
                                            constant:12],
            [progress.leadingAnchor constraintEqualToAnchor:instruction.leadingAnchor],
            [progress.trailingAnchor constraintEqualToAnchor:instruction.trailingAnchor],
            [progress.topAnchor constraintEqualToAnchor:phase.bottomAnchor constant:18],
            [closeButton.trailingAnchor constraintEqualToAnchor:instruction.trailingAnchor],
            [closeButton.bottomAnchor constraintEqualToAnchor:content.bottomAnchor
                                                      constant:-18],
            [closeButton.widthAnchor constraintGreaterThanOrEqualToConstant:88],
        ]];

        [panel center];
        [panel makeKeyAndOrderFront:nil];
        [NSApp activateIgnoringOtherApps:YES];
        electrobun_pump_installer_events([NSDate date]);
        return (__bridge_retained void *)ui;
    }
}

void electrobun_macos_installer_ui_set_phase(
    void *handle,
    const char *phase_utf8,
    int marquee) {
    @autoreleasepool {
        if (![NSThread isMainThread] || handle == NULL || phase_utf8 == NULL) return;
        ElectrobunInstallerProgressUI *ui =
            electrobun_macos_installer_ui(handle);
        if (ui.terminal || ui.dismissed) return;

        NSString *phase = [NSString stringWithUTF8String:phase_utf8];
        if (phase != nil) ui.phaseLabel.stringValue = phase;
        if (marquee) {
            ui.progressIndicator.indeterminate = YES;
            [ui.progressIndicator startAnimation:nil];
        } else {
            [ui.progressIndicator stopAnimation:nil];
            ui.progressIndicator.indeterminate = NO;
        }
        electrobun_pump_installer_events([NSDate date]);
    }
}

void electrobun_macos_installer_ui_set_progress(
    void *handle,
    unsigned int percent) {
    @autoreleasepool {
        if (![NSThread isMainThread] || handle == NULL) return;
        ElectrobunInstallerProgressUI *ui =
            electrobun_macos_installer_ui(handle);
        if (ui.terminal || ui.dismissed) return;

        [ui.progressIndicator stopAnimation:nil];
        ui.progressIndicator.indeterminate = NO;
        ui.progressIndicator.doubleValue = percent > 100 ? 100 : percent;
        electrobun_pump_installer_events([NSDate date]);
    }
}

void electrobun_macos_installer_ui_complete(
    void *handle,
    int succeeded,
    const char *message_utf8) {
    @autoreleasepool {
        if (![NSThread isMainThread] || handle == NULL) return;
        ElectrobunInstallerProgressUI *ui =
            electrobun_macos_installer_ui(handle);
        if (ui.terminal || ui.dismissed) return;

        ui.terminal = YES;
        [ui.progressIndicator stopAnimation:nil];
        ui.progressIndicator.indeterminate = NO;
        if (succeeded) ui.progressIndicator.doubleValue = 100;
        ui.instructionLabel.stringValue = succeeded
            ? @"Installation complete"
            : @"Installation failed";
        if (message_utf8 != NULL) {
            NSString *message = [NSString stringWithUTF8String:message_utf8];
            if (message != nil) ui.phaseLabel.stringValue = message;
        }
        ui.closeButton.hidden = NO;
        [ui.panel makeFirstResponder:ui.closeButton];
        electrobun_pump_installer_events([NSDate date]);

        const char *autoclose = getenv("ELECTROBUN_INSTALLER_UI_AUTOCLOSE");
        if (autoclose != NULL && strcmp(autoclose, "1") == 0) {
            [ui dismiss:nil];
            return;
        }

        while (!ui.dismissed) {
            @autoreleasepool {
                electrobun_pump_installer_events(
                    [NSDate dateWithTimeIntervalSinceNow:0.05]);
            }
        }
    }
}

void electrobun_macos_installer_ui_close(void *handle) {
    @autoreleasepool {
        if (handle == NULL) return;
        ElectrobunInstallerProgressUI *ui =
            (__bridge_transfer ElectrobunInstallerProgressUI *)handle;
        if ([NSThread isMainThread]) {
            [ui dismiss:nil];
            [ui.panel close];
            electrobun_pump_installer_events([NSDate date]);
        }
    }
}

enum {
    ELECTROBUN_UNINSTALL_CANCEL = 0,
    ELECTROBUN_UNINSTALL_APP = 1,
    ELECTROBUN_UNINSTALL_APP_AND_DATA = 2,
};

static int electrobun_show_macos_uninstall_prompt(
    const char *app_name_utf8,
    NSString *informative_text) {
    @autoreleasepool {
        if (app_name_utf8 == NULL || informative_text == nil) {
            return ELECTROBUN_UNINSTALL_CANCEL;
        }
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

        NSString *appName = [NSString stringWithUTF8String:app_name_utf8];
        if (appName == nil) {
            return ELECTROBUN_UNINSTALL_CANCEL;
        }

        NSAlert *alert = [[NSAlert alloc] init];
        alert.messageText = [NSString stringWithFormat:@"Uninstall %@?", appName];
        alert.informativeText = informative_text;
        alert.alertStyle = NSAlertStyleWarning;

        // NSAlert's first button is the Return-key default. Escape maps to the
        // third button when it is named Cancel.
        [alert addButtonWithTitle:@"App"];
        [alert addButtonWithTitle:@"App and Data"];
        [alert addButtonWithTitle:@"Cancel"];

        [NSApp activateIgnoringOtherApps:YES];
        NSModalResponse response = [alert runModal];
        if (response == NSAlertFirstButtonReturn) {
            return ELECTROBUN_UNINSTALL_APP;
        }
        if (response == NSAlertSecondButtonReturn) {
            return ELECTROBUN_UNINSTALL_APP_AND_DATA;
        }
        return ELECTROBUN_UNINSTALL_CANCEL;
    }
}

int electrobun_show_uninstall_prompt(const char *app_name_utf8) {
    return electrobun_show_macos_uninstall_prompt(
        app_name_utf8,
        @"The application will be removed.");
}

int electrobun_preview_macos_uninstall_prompt(const char *app_name_utf8) {
    return electrobun_show_macos_uninstall_prompt(
        app_name_utf8,
        @"UI preview only; no files will be removed.");
}

int electrobun_terminate_app_at_path(const char *app_path_utf8) {
    @autoreleasepool {
        NSString *rawPath = [NSString stringWithUTF8String:app_path_utf8];
        if (rawPath == nil) {
            return 0;
        }
        NSString *targetPath = [[rawPath stringByStandardizingPath] stringByResolvingSymlinksInPath];
        NSMutableArray<NSRunningApplication *> *matches = [NSMutableArray array];
        for (NSRunningApplication *application in
             [[NSWorkspace sharedWorkspace] runningApplications]) {
            NSURL *bundleURL = application.bundleURL;
            if (bundleURL == nil) continue;
            NSString *runningPath = [[bundleURL.path stringByStandardizingPath]
                stringByResolvingSymlinksInPath];
            if ([runningPath isEqualToString:targetPath]) {
                [matches addObject:application];
                [application terminate];
            }
        }

        for (NSUInteger attempt = 0; attempt < 50; attempt++) {
            BOOL allTerminated = YES;
            for (NSRunningApplication *application in matches) {
                if (!application.terminated) {
                    allTerminated = NO;
                    break;
                }
            }
            if (allTerminated) return 1;
            usleep(100000);
        }
        for (NSRunningApplication *application in matches) {
            if (!application.terminated) [application forceTerminate];
        }
        return 1;
    }
}
