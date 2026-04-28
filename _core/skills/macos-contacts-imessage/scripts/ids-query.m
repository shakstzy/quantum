// ids-query.m
// Query Apple's local IDS (Identity Service) for iMessage registration of a handle.
// Same mechanism Messages.app uses to color bubbles blue (iMessage) vs green (SMS).
// Runs entirely local to imagent; no FDA, no chat.db, no network from this binary.
//
// Build (imessage.sh auto-builds on first run if the binary is missing or stale):
//   clang -fobjc-arc -framework Foundation -O2 -o ids-query ids-query.m
//
// Usage:
//   ./ids-query <phone-E164-or-email>
//
// Output (single JSON line on stdout):
//   {"handle":"<input>","destination":"<tel:...|mailto:...>","status":<int>,"service":"iMessage|SMS|unknown"}
//
// Exit codes: 0 ok; 2 arg error; 3 framework/class load error.

#import <Foundation/Foundation.h>
#import <dlfcn.h>

@interface IDSIDQueryController : NSObject
+ (instancetype)sharedInstance;
- (void)addListenerID:(NSString *)listenerID forService:(NSString *)service;
- (void)removeListenerID:(NSString *)listenerID forService:(NSString *)service;
// Fresh IDS lookup (hits Apple's local imagent cache + refreshes if stale).
- (void)refreshIDStatusForDestinations:(NSArray *)destinations
                                service:(NSString *)service
                             listenerID:(NSString *)listenerID
                                  queue:(dispatch_queue_t)queue
                        completionBlock:(void(^)(NSDictionary *))completion;
// Cached-only lookup (returns whatever imagent has, may be unknown).
- (void)currentIDStatusForDestinations:(NSArray *)destinations
                                service:(NSString *)service
                             listenerID:(NSString *)listenerID
                                  queue:(dispatch_queue_t)queue
                        completionBlock:(void(^)(NSDictionary *))completion;
@end

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc < 2) {
      fprintf(stderr, "usage: ids-query <phone-E164-or-email>\n");
      return 2;
    }
    if (!dlopen("/System/Library/PrivateFrameworks/IDS.framework/IDS", RTLD_NOW)) {
      fprintf(stderr, "ids-query: failed to dlopen IDS.framework: %s\n", dlerror());
      return 3;
    }
    Class clazz = NSClassFromString(@"IDSIDQueryController");
    if (!clazz) {
      fprintf(stderr, "ids-query: IDSIDQueryController class not found (macOS version mismatch?)\n");
      return 3;
    }

    NSString *input = [NSString stringWithUTF8String:argv[1]];
    NSString *destination = [input containsString:@"@"]
      ? [NSString stringWithFormat:@"mailto:%@", input]
      : [NSString stringWithFormat:@"tel:%@", input];
    NSString *service = @"com.apple.madrid";
    NSString *listenerID = @"com.quantum.ids-query";

    id controller = [clazz sharedInstance];
    if ([controller respondsToSelector:@selector(addListenerID:forService:)]) {
      [controller addListenerID:listenerID forService:service];
    }

    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    __block NSDictionary *result = nil;

    // Prefer a fresh lookup so routing decisions reflect current iMessage state.
    // If refresh isn't exposed on this macOS, fall back to the cached path.
    SEL refreshSel = @selector(refreshIDStatusForDestinations:service:listenerID:queue:completionBlock:);
    SEL currentSel = @selector(currentIDStatusForDestinations:service:listenerID:queue:completionBlock:);
    void (^cb)(NSDictionary *) = ^(NSDictionary *results) {
      result = results;
      dispatch_semaphore_signal(sem);
    };
    dispatch_queue_t q = dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0);

    if ([controller respondsToSelector:refreshSel]) {
      [controller refreshIDStatusForDestinations:@[destination]
                                          service:service
                                       listenerID:listenerID
                                            queue:q
                                  completionBlock:cb];
    } else if ([controller respondsToSelector:currentSel]) {
      [controller currentIDStatusForDestinations:@[destination]
                                          service:service
                                       listenerID:listenerID
                                            queue:q
                                  completionBlock:cb];
    } else {
      fprintf(stderr, "ids-query: no compatible IDS lookup selector on this macOS\n");
      return 3;
    }

    long timedOut = dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC));
    if (timedOut != 0) {
      printf("{\"handle\":\"%s\",\"destination\":\"%s\",\"status\":0,\"service\":\"unknown\",\"error\":\"timeout\"}\n",
             [input UTF8String], [destination UTF8String]);
      return 0;
    }

    NSNumber *statusNum = result[destination];
    NSInteger code = statusNum ? [statusNum integerValue] : 0;
    const char *svc;
    // IDSIDQueryController status codes:
    //   0 unknown, 1 available (on iMessage), 2 unavailable (not on iMessage),
    //   3 legacy-unknown. Anything else: treat as unknown.
    switch (code) {
      case 1: svc = "iMessage"; break;
      case 2: svc = "SMS"; break;
      default: svc = "unknown"; break;
    }
    printf("{\"handle\":\"%s\",\"destination\":\"%s\",\"status\":%ld,\"service\":\"%s\"}\n",
           [input UTF8String], [destination UTF8String], (long)code, svc);
    return 0;
  }
}
