// An off-screen source and one inactive destination in the installed WebKit engine.
#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>

static void fail(NSString *reason) {
    fprintf(stderr, "WebKit dock check: %s\n", reason.UTF8String);
    exit(1);
}

@interface DockCheck : NSObject <WKWebExtensionControllerDelegate, WKWebExtensionWindow, WKWebExtensionTab, WKNavigationDelegate>
@property WKWebExtensionController *controller;
@property WKWebExtensionContext *context;
@property WKWebView *view;
@property NSWindow *window;
@property NSURL *sourceURL;
@property NSUInteger loads;
@end

@interface DestinationTab : NSObject <WKWebExtensionTab, WKNavigationDelegate>
@property WKWebView *view;
@property (weak) DockCheck *owner;
@end

@implementation DestinationTab
- (id<WKWebExtensionWindow>)windowForWebExtensionContext:(WKWebExtensionContext *)context { return self.owner; }
- (WKWebView *)webViewForWebExtensionContext:(WKWebExtensionContext *)context { return self.view; }
- (void)webView:(WKWebView *)view didFinishNavigation:(WKNavigation *)navigation {
    [self.owner.controller didChangeTabProperties:WKWebExtensionTabChangedPropertiesLoading | WKWebExtensionTabChangedPropertiesURL forTab:self];
}
@end

@interface DockCheck ()
@property DestinationTab *destination;
@property NSUInteger siteRequests;
@end

@implementation DockCheck
- (NSArray *)webExtensionController:(WKWebExtensionController *)controller openWindowsForExtensionContext:(WKWebExtensionContext *)context { return @[self]; }
- (id<WKWebExtensionWindow>)webExtensionController:(WKWebExtensionController *)controller focusedWindowForExtensionContext:(WKWebExtensionContext *)context { return self; }
- (NSArray *)tabsForWebExtensionContext:(WKWebExtensionContext *)context { return self.destination ? @[self, self.destination] : @[self]; }
- (id<WKWebExtensionTab>)activeTabForWebExtensionContext:(WKWebExtensionContext *)context { return self; }
- (id<WKWebExtensionWindow>)windowForWebExtensionContext:(WKWebExtensionContext *)context { return self; }
- (WKWebView *)webViewForWebExtensionContext:(WKWebExtensionContext *)context { return self.view; }

- (void)webExtensionController:(WKWebExtensionController *)controller sendMessage:(id)message toApplicationWithIdentifier:(NSString *)app forExtensionContext:(WKWebExtensionContext *)context replyHandler:(void (^)(id, NSError *))reply {
    NSString *type = message[@"type"];
    if ([type isEqual:@"test.fail"]) fail(message[@"error"]);
    if ([type isEqual:@"test.phase"]) {
        reply(@(self.loads), nil);
    } else if ([type isEqual:@"test.clickPermission"]) {
        // Deliver an actual pointer event to the extension iframe. A script-only
        // click cannot establish Safari's gesture for permissions.request().
        [self.view evaluateJavaScript:@"document.getElementById('safari-chat-host').getBoundingClientRect().left" completionHandler:^(NSNumber *edge, NSError *error) {
            if (error || !self.destination || self.siteRequests) fail(@"Unexpected website permission state before the click.");
            NSPoint point = NSMakePoint(edge.doubleValue + [message[@"x"] doubleValue], self.view.bounds.size.height - [message[@"y"] doubleValue]);
            for (NSNumber *mouseType in @[@(NSEventTypeLeftMouseDown), @(NSEventTypeLeftMouseUp)]) {
                NSEvent *event = [NSEvent mouseEventWithType:mouseType.unsignedIntegerValue location:point modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:self.window.windowNumber context:nil eventNumber:1 clickCount:1 pressure:1];
                [self.window sendEvent:event];
            }
            reply(@YES, nil);
        }];
    } else if ([type isEqual:@"test.reload"] || [type isEqual:@"test.done"]) {
        NSString *layout = [NSString stringWithFormat:@"(()=>{const h=document.getElementById('safari-chat-host')?.getBoundingClientRect(); return h?.left>0 && h.width>=300 && h.right===innerWidth && innerWidth===%d && document.querySelector('main').getBoundingClientRect().right<=h.left+1})()", self.loads == 1 ? 1280 : 620];
        [self.view evaluateJavaScript:layout completionHandler:^(id fits, NSError *error) {
            if (error || ![fits boolValue]) fail(@"The website and dock did not fit side by side.");
            reply(@YES, nil);
            if ([type isEqual:@"test.reload"]) {
                if (self.loads == 1) [self.window setContentSize:NSMakeSize(620, 800)];
                [self.view reload];
            } else {
                if (self.loads != 4) fail(@"Expected three full reloads.");
                if (!self.destination || self.siteRequests != 1) fail(@"Expected one inactive destination and one exact website request.");
                puts("System WebKit passed three dock reloads and read a second website in one inactive tab after a real permission request from the restored source pane.");
                exit(0);
            }
        }];
    } else if ([type isEqual:@"auth.status"] || [type isEqual:@"auth.credential"]) {
        reply(@{@"ok":@YES, @"connected":@YES, @"canInfer":@YES, @"account":@"fixture", @"generation":@"test", @"label":@"Test account", @"token":@"fixture-only"}, nil);
    } else {
        fail([@"Unexpected native request: " stringByAppendingString:type]);
    }
}
- (void)webExtensionController:(WKWebExtensionController *)controller openNewTabUsingConfiguration:(WKWebExtensionTabConfiguration *)configuration forExtensionContext:(WKWebExtensionContext *)context completionHandler:(void (^)(id<WKWebExtensionTab>, NSError *))completion {
    if (self.destination || configuration.shouldBeActive || ![configuration.url.host isEqual:@"localhost"] || ![configuration.url.path isEqual:@"/__workflow/two"] || ![configuration.url.port isEqual:self.sourceURL.port]) fail(@"Unexpected new tab.");
    self.destination = [DestinationTab new];
    self.destination.owner = self;
    self.destination.view = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 1024, 720) configuration:self.view.configuration];
    self.destination.view.navigationDelegate = self.destination;
    [controller didOpenTab:self.destination];
    [self.destination.view loadRequest:[NSURLRequest requestWithURL:configuration.url]];
    completion(self.destination, nil);
}
- (void)webExtensionController:(WKWebExtensionController *)controller promptForPermissionMatchPatterns:(NSSet<WKWebExtensionMatchPattern *> *)patterns inTab:(id<WKWebExtensionTab>)tab forExtensionContext:(WKWebExtensionContext *)context completionHandler:(void (^)(NSSet<WKWebExtensionMatchPattern *> *, NSDate *))completion {
    if (!self.destination || ++self.siteRequests != 1 || patterns.count != 1 || ![patterns.anyObject.string isEqual:@"http://localhost/*"]) fail(@"Expected a permission request for only the destination hostname.");
    completion(patterns, nil);
}
- (void)webView:(WKWebView *)view didFinishNavigation:(WKNavigation *)navigation {
    self.loads++;
    fprintf(stderr, "Source loaded %lu\n", self.loads);
    [self.controller didChangeTabProperties:WKWebExtensionTabChangedPropertiesLoading | WKWebExtensionTabChangedPropertiesURL forTab:self];
    if (self.loads == 1) [self.context performActionForTab:self];
}
- (void)load:(NSURL *)directory {
    [WKWebExtension extensionWithResourceBaseURL:directory completionHandler:^(WKWebExtension *extension, NSError *error) {
        if (!extension) fail(error.localizedDescription);
        WKWebExtensionControllerConfiguration *ephemeral = WKWebExtensionControllerConfiguration.nonPersistentConfiguration;
        ephemeral.defaultWebsiteDataStore = WKWebsiteDataStore.nonPersistentDataStore;
        self.controller = [[WKWebExtensionController alloc] initWithConfiguration:ephemeral];
        self.controller.delegate = self;
        self.context = [WKWebExtensionContext contextForExtension:extension];
        self.context.hasAccessToPrivateData = YES;
        for (NSString *permission in extension.requestedPermissions) [self.context setPermissionStatus:WKWebExtensionContextPermissionStatusGrantedExplicitly forPermission:permission];
        [self.context setPermissionStatus:WKWebExtensionContextPermissionStatusGrantedExplicitly forURL:self.sourceURL];
        WKWebViewConfiguration *config = [WKWebViewConfiguration new];
        config.preferences.inactiveSchedulingPolicy = WKInactiveSchedulingPolicyNone;
        config.webExtensionController = self.controller;
        config.websiteDataStore = ephemeral.defaultWebsiteDataStore;
        NSRect bounds = NSMakeRect(-10000, -10000, 1280, 800);
        self.window = [[NSWindow alloc] initWithContentRect:bounds styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
        self.view = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 1280, 800) configuration:config];
        self.window.contentView = self.view;
        [self.window orderFront:nil];
        self.view.navigationDelegate = self;
        NSError *failure = nil;
        if (![self.controller loadExtensionContext:self.context error:&failure]) fail(failure.localizedDescription);
        [self.context loadBackgroundContentWithCompletionHandler:^(NSError *failure) {
            if (failure) fail(failure.localizedDescription);
            [self.view loadRequest:[NSURLRequest requestWithURL:self.sourceURL]];
        }];
    }];
}
@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 3 || ![@(argv[1]) isAbsolutePath]) return 2;
        NSApplication *app = NSApplication.sharedApplication;
        [app setActivationPolicy:NSApplicationActivationPolicyProhibited];
        DockCheck *test = [DockCheck new];
        test.sourceURL = [NSURL URLWithString:@(argv[2])];
        if (![test.sourceURL.host isEqual:@"127.0.0.1"] || ![test.sourceURL.scheme isEqual:@"http"]) return 2;
        [test load:[NSURL fileURLWithPath:@(argv[1]) isDirectory:YES]];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 40 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{ fail(@"Timed out waiting for the fixture task."); });
        [app run];
        return 0;
    }
}
