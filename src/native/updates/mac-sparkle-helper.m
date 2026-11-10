#import <Cocoa/Cocoa.h>
#import <Sparkle/Sparkle.h>

// Sparkle ignores dash suffixes; encode our release order as numeric components.
static NSString *CanvasOrderingVersion(NSString *version) {
  NSString *release = [[version componentsSeparatedByString:@"+"] firstObject];
  NSString *base = [[release componentsSeparatedByString:@"-"] firstObject];
  if ([base rangeOfString:@"^[0-9]+\\.[0-9]+\\.[0-9]+$" options:NSRegularExpressionSearch].location == NSNotFound) return version;
  if ([release isEqualToString:base]) return [base stringByAppendingString:@".1"];
  if ([release rangeOfString:@"-hotfix\\.(0|[1-9][0-9]*)$" options:NSRegularExpressionSearch].location != NSNotFound) {
    return [release stringByReplacingOccurrencesOfString:@"-hotfix." withString:@".2."];
  }
  return [base stringByAppendingFormat:@".0%@", [release substringFromIndex:base.length + 1]];
}

// Electron has already shown the update and received the user's install action.
// Sparkle starts only here, so a normal exit after Download cannot install it.
@interface CanvasUpdateDriver : NSObject <SPUUserDriver, SPUUpdaterDelegate, SUVersionComparison>
@property (nonatomic, copy) NSString *feedURL;
@property (nonatomic, copy) NSString *archiveURL;
@property (nonatomic, copy) NSString *version;
@property (nonatomic) BOOL probe;
@end

@implementation CanvasUpdateDriver
- (id<SUVersionComparison>)versionComparatorForUpdater:(SPUUpdater *)updater { return self; }
- (NSComparisonResult)compareVersion:(NSString *)versionA toVersion:(NSString *)versionB {
  return [[SUStandardVersionComparator defaultComparator] compareVersion:CanvasOrderingVersion(versionA) toVersion:CanvasOrderingVersion(versionB)];
}
- (NSString *)feedURLStringForUpdater:(SPUUpdater *)updater { return self.feedURL; }
- (BOOL)updaterShouldPromptForPermissionToCheckForUpdates:(SPUUpdater *)updater { return NO; }
- (void)updater:(SPUUpdater *)updater didFindValidUpdate:(SUAppcastItem *)item {
  if (!self.probe) return;
  if (![item.displayVersionString isEqualToString:self.version] || item.informationOnlyUpdate) {
    fprintf(stderr, "Sparkle probe selected a different version\n");
    exit(11);
  }
  printf("SPARKLE_AVAILABLE:%s\n", item.displayVersionString.UTF8String);
  fflush(stdout);
  exit(0);
}
- (void)updaterDidNotFindUpdate:(SPUUpdater *)updater error:(NSError *)error {
  if (!self.probe) return;
  puts("SPARKLE_NO_UPDATE");
  fflush(stdout);
  exit(0);
}
- (void)updater:(SPUUpdater *)updater didAbortWithError:(NSError *)error {
  if (!self.probe) return;
  fprintf(stderr, "Sparkle probe error: %s\n", error.localizedDescription.UTF8String);
  exit(14);
}
- (void)updater:(SPUUpdater *)updater willDownloadUpdate:(SUAppcastItem *)item withRequest:(NSMutableURLRequest *)request {
  if (![item.displayVersionString isEqualToString:self.version]) {
    fprintf(stderr, "Sparkle selected a different version\n");
    exit(10);
  }
  request.URL = [NSURL URLWithString:self.archiveURL];
}
- (void)showUpdatePermissionRequest:(SPUUpdatePermissionRequest *)request reply:(void (^)(SUUpdatePermissionResponse *))reply {
  reply([[SUUpdatePermissionResponse alloc] initWithAutomaticUpdateChecks:NO automaticUpdateDownloading:@NO sendSystemProfile:NO]);
}
- (void)showUserInitiatedUpdateCheckWithCancellation:(void (^)(void))cancellation {}
- (void)showUpdateFoundWithAppcastItem:(SUAppcastItem *)item state:(SPUUserUpdateState *)state reply:(void (^)(SPUUserUpdateChoice))reply {
  if (![item.displayVersionString isEqualToString:self.version] || item.informationOnlyUpdate) {
    fprintf(stderr, "Sparkle appcast does not match the selected update\n");
    reply(SPUUserUpdateChoiceDismiss);
    exit(11);
  }
  reply(SPUUserUpdateChoiceInstall);
}
- (void)showUpdateReleaseNotesWithDownloadData:(SPUDownloadData *)downloadData {}
- (void)showUpdateReleaseNotesFailedToDownloadWithError:(NSError *)error {}
- (void)showUpdateNotFoundWithError:(NSError *)error acknowledgement:(void (^)(void))acknowledgement {
  fprintf(stderr, "Sparkle found no update: %s\n", error.localizedDescription.UTF8String);
  acknowledgement();
  exit(12);
}
- (void)showUpdaterError:(NSError *)error acknowledgement:(void (^)(void))acknowledgement {
  fprintf(stderr, "Sparkle error: %s\n", error.localizedDescription.UTF8String);
  acknowledgement();
  exit(13);
}
- (void)showDownloadInitiatedWithCancellation:(void (^)(void))cancellation {}
- (void)showDownloadDidReceiveExpectedContentLength:(uint64_t)expectedContentLength {}
- (void)showDownloadDidReceiveDataOfLength:(uint64_t)length {}
- (void)showDownloadDidStartExtractingUpdate {}
- (void)showExtractionReceivedProgress:(double)progress {}
- (void)showReadyToInstallAndRelaunch:(void (^)(SPUUserUpdateChoice))reply { reply(SPUUserUpdateChoiceInstall); }
- (void)showInstallingUpdateWithApplicationTerminated:(BOOL)applicationTerminated retryTerminatingApplication:(void (^)(void))retryTerminatingApplication {}
- (void)showUpdateInstalledAndRelaunched:(BOOL)relaunched acknowledgement:(void (^)(void))acknowledgement { acknowledgement(); exit(0); }
- (void)dismissUpdateInstallation {}
@end

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc == 2 && strcmp(argv[1], "--self-check") == 0) {
      CanvasUpdateDriver *driver = [CanvasUpdateDriver new];
      NSArray<NSString *> *versions = @[@"1.8.5-hotfix.10", @"1.8.6-beta2", @"1.8.6", @"1.8.6-hotfix.0", @"1.8.6-hotfix.1", @"1.8.6-hotfix.2", @"1.8.6-hotfix.10", @"1.8.7"];
      for (NSUInteger i = 0; i < versions.count; i++) {
        for (NSUInteger j = 0; j < versions.count; j++) {
          NSComparisonResult expected = i < j ? NSOrderedAscending : i > j ? NSOrderedDescending : NSOrderedSame;
          if ([driver compareVersion:versions[i] toVersion:versions[j]] != expected) return 20;
        }
      }
      if ([driver compareVersion:@"1.8.6-hotfix.1+build.2" toVersion:@"1.8.6-hotfix.1"] != NSOrderedSame) return 21;
      puts("Update version ordering self-check passed");
      return 0;
    }
    if (argc != 5 && argc != 6) return 2;
    NSString *applicationPath = [NSString stringWithUTF8String:argv[1]];
    NSBundle *applicationBundle = [NSBundle bundleWithPath:applicationPath];
    if (!applicationBundle) return 3;
    [NSApplication sharedApplication];
    CanvasUpdateDriver *driver = [CanvasUpdateDriver new];
    driver.feedURL = [NSString stringWithUTF8String:argv[2]];
    driver.archiveURL = [NSString stringWithUTF8String:argv[3]];
    driver.version = [NSString stringWithUTF8String:argv[4]];
    driver.probe = argc == 6 && strcmp(argv[5], "--probe") == 0;
    SPUUpdater *updater = [[SPUUpdater alloc] initWithHostBundle:applicationBundle applicationBundle:applicationBundle userDriver:driver delegate:driver];
    updater.automaticallyChecksForUpdates = NO;
    updater.automaticallyDownloadsUpdates = NO;
    NSError *error = nil;
    if (![updater startUpdater:&error]) {
      fprintf(stderr, "Sparkle could not start: %s\n", error.localizedDescription.UTF8String);
      return 4;
    }
    puts("SPARKLE_STARTED");
    fflush(stdout);
    if (driver.probe) [updater checkForUpdateInformation];
    else [updater checkForUpdates];
    [[NSRunLoop currentRunLoop] run];
    return 5;
  }
}
