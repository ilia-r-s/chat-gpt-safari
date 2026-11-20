// An off-screen source and one inactive destination in the installed WebKit engine.
#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>

static void fail(NSString *reason) {
    fprintf(stderr, "WebKit dock check: %s\n", reason.UTF8String);
    exit(1);
}

// The test host supplies the foreground tab. Its offscreen window can be
// occluded by other apps or the lock screen, independently of that tab state.
@interface SourceWindow : NSWindow
@end
@implementation SourceWindow
- (NSWindowOcclusionState)occlusionState { return NSWindowOcclusionStateVisible; }
@end

@interface DockCheck : NSObject <WKWebExtensionControllerDelegate, WKWebExtensionWindow, WKWebExtensionTab, WKNavigationDelegate>
@property WKWebExtensionController *controller;
@property WKWebExtensionContext *context;
@property WKWebView *view;
@property NSWindow *window;
@property NSURL *sourceURL;
@property NSUInteger loads;
- (void)selectTab:(id<WKWebExtensionTab>)tab;
- (void)closeDestination:(id<WKWebExtensionTab>)tab;
@end

@interface DestinationTab : NSObject <WKWebExtensionTab, WKNavigationDelegate>
@property WKWebView *view;
@property (weak) DockCheck *owner;
@end

@implementation DestinationTab
- (void)closeForWebExtensionContext:(WKWebExtensionContext *)context completionHandler:(void (^)(NSError *))completion {
    [self.owner closeDestination:self];
    completion(nil);
}
- (void)activateForWebExtensionContext:(WKWebExtensionContext *)context completionHandler:(void (^)(NSError *))completion {
    [self.owner selectTab:self];
    completion(nil);
}
- (id<WKWebExtensionWindow>)windowForWebExtensionContext:(WKWebExtensionContext *)context { return self.owner; }
- (WKWebView *)webViewForWebExtensionContext:(WKWebExtensionContext *)context { return self.view; }
- (void)webView:(WKWebView *)view didFinishNavigation:(WKNavigation *)navigation {
    [self.owner.controller didChangeTabProperties:WKWebExtensionTabChangedPropertiesLoading | WKWebExtensionTabChangedPropertiesURL forTab:self];
}
@end

@interface DockCheck ()
- (void)addDestination:(NSURL *)url;
@property DestinationTab *destination;
@property NSUInteger siteRequests;
@property NSUInteger tabSwitches;
@property BOOL manualTab;
@property (copy) NSString *clipboardFixture;
@end

@implementation DockCheck
- (NSArray *)webExtensionController:(WKWebExtensionController *)controller openWindowsForExtensionContext:(WKWebExtensionContext *)context { return @[self]; }
- (id<WKWebExtensionWindow>)webExtensionController:(WKWebExtensionController *)controller focusedWindowForExtensionContext:(WKWebExtensionContext *)context { return self; }
- (NSArray *)tabsForWebExtensionContext:(WKWebExtensionContext *)context { return self.destination ? @[self, self.destination] : @[self]; }
- (id<WKWebExtensionTab>)activeTabForWebExtensionContext:(WKWebExtensionContext *)context {
    return self.window.contentView == self.destination.view && self.destination ? (id<WKWebExtensionTab>)self.destination : self;
}
- (void)selectTab:(id<WKWebExtensionTab>)tab {
    id<WKWebExtensionTab> previous = [self activeTabForWebExtensionContext:self.context];
    if (previous == tab) return;
    self.tabSwitches++;
    self.window.contentView = tab == self ? self.view : self.destination.view;
    [self.controller didActivateTab:tab previousActiveTab:previous];
}
- (void)closeDestination:(id<WKWebExtensionTab>)tab {
    if (tab != self.destination) fail(@"Unexpected tab closure.");
    if (self.window.contentView == self.destination.view) [self selectTab:self];
    self.destination = nil;
    [self.controller didCloseTab:tab windowIsClosing:NO];
}
- (void)activateForWebExtensionContext:(WKWebExtensionContext *)context completionHandler:(void (^)(NSError *))completion {
    [self selectTab:self];
    completion(nil);
}
- (id<WKWebExtensionWindow>)windowForWebExtensionContext:(WKWebExtensionContext *)context { return self; }
- (WKWebView *)webViewForWebExtensionContext:(WKWebExtensionContext *)context { return self.view; }

- (void)webExtensionController:(WKWebExtensionController *)controller sendMessage:(id)message toApplicationWithIdentifier:(NSString *)app forExtensionContext:(WKWebExtensionContext *)context replyHandler:(void (^)(id, NSError *))reply {
    NSString *type = message[@"type"];
    if ([type hasPrefix:@"test."]) fprintf(stderr, "%s at document %lu\n", type.UTF8String, self.loads);
    if ([type isEqual:@"test.fail"]) fail(message[@"error"]);
    else if ([type isEqual:@"test.phase"]) {
        reply(@(self.loads), nil);
    } else if ([type isEqual:@"test.showSource"]) {
        [self.view callAsyncJavaScript:@"for(let i=0;document.hidden && i<60;i++) await new Promise(r=>setTimeout(r,35)); return !document.hidden" arguments:@{} inFrame:nil inContentWorld:WKContentWorld.pageWorld completionHandler:^(NSNumber *visible, NSError *error) {
            if (error || !visible.boolValue) fail(@"The test window did not become visible to WebKit.");
            reply(@YES, nil);
        }];
    } else if ([type isEqual:@"test.manualTab"]) {
        if (self.destination) fail(@"Unexpected manual tab setup.");
        self.manualTab = YES;
        NSURLComponents *url = [NSURLComponents componentsWithURL:self.sourceURL resolvingAgainstBaseURL:NO];
        url.host = @"localhost"; url.path = @"/__workflow/yahoo"; url.query = nil;
        [self addDestination:url.URL];
        reply(@YES,nil);
    } else if ([type isEqual:@"test.followLink"]) {
        // The website initiates this navigation while the model stream is pending.
        [self.view evaluateJavaScript:@"{const a=document.createElement('a');a.href='/__workflow/one?slow-resource&slow-head';document.body.append(a);a.click()}" completionHandler:^(id result, NSError *error) {
            if (error) fail(error.localizedDescription);
        }];
        reply(@YES,nil);
    } else if ([type isEqual:@"test.earlyRestore"]) {
        [self.view evaluateJavaScript:@"document.readyState !== 'complete' && (window.paneMountedBeforeBody || (!document.body && !!document.getElementById('safari-chat-host')))" completionHandler:^(NSNumber *early, NSError *error) {
            if (error || !early.boolValue) fail(@"The pane waited for the website's delayed body.");
            reply(@YES,nil);
        }];
    } else if ([type isEqual:@"test.sketch"]) {
        NSString *setup = @"(()=>{const c=document.createElement('canvas');c.id='sketch';c.setAttribute('aria-label','Sketch pad');c.style.cssText='position:fixed;top:100px;left:12px;width:140px;height:90px;z-index:10';document.body.append(c);let held=false,moves=0;c.onpointerdown=e=>{held=e.buttons===1};c.onpointermove=e=>{if(held&&e.buttons===1)moves++};c.onpointerup=e=>{c.dataset.drawn=String(held&&moves>=3&&e.buttons===0);held=false};return true})()";
        [self.view evaluateJavaScript:setup completionHandler:^(id success, NSError *error) {
            if (error || ![success boolValue]) fail(@"Could not mount the WebKit drawing surface.");
            reply(@YES, nil);
        }];
    } else if ([type isEqual:@"test.input"]) {
        NSString *setup = @"(()=>{const d=document.createElement('div');d.style.cssText='position:fixed;left:4px;top:220px;width:175px;z-index:10;background:white';d.innerHTML='<input id=wkfield aria-label=Notes><p id=wktext>Alpha <strong>beta</strong> gamma.</p><button id=wkdouble style=position:static>Double target</button>';document.body.append(d);d.querySelector('button').ondblclick=e=>e.target.dataset.twice=String(e.detail===2);return true})()";
        [self.view evaluateJavaScript:setup completionHandler:^(id ok, NSError *error) {
            if (error || ![ok boolValue]) fail(@"Could not mount the input fixture.");
            reply(@YES, nil);
        }];
    } else if ([type isEqual:@"clipboard.read"] || [type isEqual:@"clipboard.write"]) {
        if (![message[@"generation"] isEqual:@"test"]) fail(@"Clipboard operation used the wrong test session.");
        if ([type isEqual:@"clipboard.write"]) self.clipboardFixture = message[@"text"];
        reply(@{@"ok":@YES, @"text":self.clipboardFixture ?: @""}, nil);
    } else if ([type isEqual:@"test.clickPermission"]) {
        // Deliver an actual pointer event to the extension iframe. A script-only
        // click cannot establish Safari's gesture for permissions.request().
        [self.view evaluateJavaScript:@"document.getElementById('safari-chat-host').getBoundingClientRect().left" completionHandler:^(NSNumber *edge, NSError *error) {
            if (error || !self.destination || self.siteRequests != 0) fail(@"Unexpected website permission state before the click.");
            NSPoint point = NSMakePoint(edge.doubleValue + [message[@"x"] doubleValue], self.view.bounds.size.height - [message[@"y"] doubleValue]);
            for (NSNumber *mouseType in @[@(NSEventTypeLeftMouseDown), @(NSEventTypeLeftMouseUp)]) {
                NSEvent *event = [NSEvent mouseEventWithType:mouseType.unsignedIntegerValue location:point modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:self.window.windowNumber context:nil eventNumber:1 clickCount:1 pressure:1];
                [self.window sendEvent:event];
            }
            reply(@YES, nil);
        }];
    } else if ([type isEqual:@"test.reload"] || [type isEqual:@"test.done"]) {
        NSString *layout = [NSString stringWithFormat:@"for(let i=0;i<100;i++){const h=document.getElementById('safari-chat-host')?.getBoundingClientRect(), m=document.querySelector('main')?.getBoundingClientRect(); if(h?.left>0 && h.width>=300 && h.right===innerWidth && innerWidth===%d && m?.right<=h.left+1)return true; await new Promise(r=>setTimeout(r,50))}return false", self.loads == 1 ? 1280 : 620];
        [self.view callAsyncJavaScript:layout arguments:@{} inFrame:nil inContentWorld:WKContentWorld.pageWorld completionHandler:^(id fits, NSError *error) {
            if (error || ![fits boolValue]) fail(@"The website and dock did not fit side by side.");
            reply(@YES, nil);
            if ([type isEqual:@"test.reload"]) {
                if (self.loads == 1) [self.window setContentSize:NSMakeSize(620, 800)];
                [self.view reload];
            } else {
                if ([self.sourceURL.path isEqual:@"/__workflow/finance-source"]) {
                    if (self.loads != 1 || self.siteRequests != 1 || self.destination || self.tabSwitches) fail(@"Unexpected tab or permission state after the background quote lookup.");
                    puts("System WebKit found a quote by typing and submitting in a background tab, recovered from a stale control, and closed only the requested tab.");
                    exit(0);
                }
                if ([self.sourceURL.path isEqual:@"/__workflow/paint-source"]) {
                    if (self.loads != 1 || self.siteRequests != 1 || self.tabSwitches != 4 || self.window.contentView != self.view) fail(@"Unexpected tab selection, reload or permission request in the Paint workflow.");
                    puts("System WebKit opened and read a hidden tab, drew a ten-second stroke after activating it, restored chat, and explicitly switched tabs both ways.");
                    exit(0);
                }
                if ([self.sourceURL.path isEqual:@"/__workflow/carousel"]) {
                    if (self.loads != 1 || self.siteRequests || self.destination) fail(@"Unexpected navigation or permission request.");
                    [self.view evaluateJavaScript:@"window.verifyWorkflow()" completionHandler:^(id result, NSError *error) {
                        if (error || ![result isEqual:@"ok"]) fail(error.localizedDescription ?: result);
                        puts("System WebKit passed one Chat turn with four picture swipes, bottom and top scrolling, a variable-speed zigzag, and a single turtle stroke.");
                        exit(0);
                    }];
                    return;
                }
                if (self.siteRequests != 1) fail(@"Expected one website permission request.");
                if (self.manualTab) {
                    if (self.loads != 1) fail(@"Selecting the manually opened tab reloaded the source.");
                    puts("System WebKit passed manual tab access, finding an offscreen headline, stopping at the carousel, swiping twice and delivering pinch and rotation to the website.");
                    exit(0);
                }
                if (self.loads != 4) fail(@"Unexpected source navigation count.");
                [self.view evaluateJavaScript:@"String(document.querySelector('button').dataset.pointerHit==='true' && document.getElementById('sketch').dataset.drawn==='true' && document.body.dataset.hover==='complete' && document.getElementById('wkdouble').dataset.twice==='true' && document.getElementById('wkfield').value==='YesHi' && document.querySelector('#wktext strong').textContent==='Hi')" completionHandler:^(id hit, NSError *error) {
                    if (error || ![hit isEqual:@"true"]) fail([NSString stringWithFormat:@"The website's final pointer, field or text state did not match the requested actions: %@ %@", hit, error]);
                    puts("System WebKit passed navigation recovery before load, including a pending approval, a streaming reply and subsequent pointer, keyboard and clipboard actions.");
                    exit(0);
                }];
            }
        }];
    } else if ([type isEqual:@"auth.status"] || [type isEqual:@"auth.credential"]) {
        reply(@{@"ok":@YES, @"connected":@YES, @"canInfer":@YES, @"account":@"fixture", @"generation":@"test", @"label":@"Test account", @"token":@"fixture-only"}, nil);
    } else {
        fail([@"Unexpected native request: " stringByAppendingString:type]);
    }
}
- (void)webExtensionController:(WKWebExtensionController *)controller openNewTabUsingConfiguration:(WKWebExtensionTabConfiguration *)configuration forExtensionContext:(WKWebExtensionContext *)context completionHandler:(void (^)(id<WKWebExtensionTab>, NSError *))completion {
    NSString *expected = [self.sourceURL.path isEqual:@"/__workflow/paint-source"] ? @"/__workflow/paint" : @"/__workflow/two";
    if ([self.sourceURL.path isEqual:@"/__workflow/finance-source"]) expected = @"/__workflow/finance";
    if (self.destination || configuration.shouldBeActive || ![configuration.url.host isEqual:@"localhost"] || ![configuration.url.path isEqual:expected] || ![configuration.url.port isEqual:self.sourceURL.port]) fail(@"Unexpected new tab.");
    [self addDestination:configuration.url];
    completion(self.destination, nil);
}
- (void)addDestination:(NSURL *)url {
    self.destination = [DestinationTab new];
    self.destination.owner = self;
    self.destination.view = [[WKWebView alloc] initWithFrame:self.view.bounds configuration:self.view.configuration];
    self.destination.view.navigationDelegate = self.destination;
    [self.controller didOpenTab:self.destination];
    [self.destination.view loadRequest:[NSURLRequest requestWithURL:url]];
}
- (void)webExtensionController:(WKWebExtensionController *)controller promptForPermissionMatchPatterns:(NSSet<WKWebExtensionMatchPattern *> *)patterns inTab:(id<WKWebExtensionTab>)tab forExtensionContext:(WKWebExtensionContext *)context completionHandler:(void (^)(NSSet<WKWebExtensionMatchPattern *> *, NSDate *))completion {
    NSString *expected = @"http://localhost/*";
    if (!self.destination || ++self.siteRequests != 1 || patterns.count != 1 || ![patterns.anyObject.string isEqual:expected]) fail(@"Expected a permission request for only the destination hostname.");
    completion(patterns, nil);
}
- (void)webView:(WKWebView *)view didCommitNavigation:(WKNavigation *)navigation {
    self.loads++;
    fprintf(stderr, "Document %lu committed %s\n", self.loads, view.URL.absoluteString.UTF8String);
}
- (void)webViewWebContentProcessDidTerminate:(WKWebView *)view {
    fail(@"The fixture website's WebKit process terminated.");
}
- (void)webView:(WKWebView *)view didFinishNavigation:(WKNavigation *)navigation {
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
        self.window = [[SourceWindow alloc] initWithContentRect:bounds styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
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
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 80 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{ fail(@"Timed out waiting for the fixture task."); });
        [app run];
        return 0;
    }
}
