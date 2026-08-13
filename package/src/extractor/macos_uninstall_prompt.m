#import <AppKit/AppKit.h>
#import <unistd.h>

enum {
    ELECTROBUN_UNINSTALL_CANCEL = 0,
    ELECTROBUN_UNINSTALL_APP = 1,
    ELECTROBUN_UNINSTALL_APP_AND_DATA = 2,
};

int electrobun_show_uninstall_prompt(const char *app_name_utf8) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

        NSString *appName = [NSString stringWithUTF8String:app_name_utf8];
        if (appName == nil) {
            return ELECTROBUN_UNINSTALL_CANCEL;
        }

        NSAlert *alert = [[NSAlert alloc] init];
        alert.messageText = [NSString stringWithFormat:@"Uninstall %@?", appName];
        alert.informativeText = @"The application will be removed.";
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
