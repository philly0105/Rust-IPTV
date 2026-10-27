#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#include <stdint.h>

@interface IptvMpvHostView : NSView
@end

@implementation IptvMpvHostView
- (BOOL)isFlipped { return YES; }
- (NSView *)hitTest:(NSPoint)point { return nil; }
@end

// Bounds arrive as CSS pixels. WKWebView CSS pixels and AppKit points have the
// same size, but the web content starts below the macOS titlebar safe area.
// backingScaleFactor applies only when allocating video pixels.
static NSRect host_frame(NSView *parent, int32_t x, int32_t y, int32_t w, int32_t h) {
    CGFloat top = parent.safeAreaInsets.top;
    CGFloat originY = parent.isFlipped ? y + top : NSHeight(parent.bounds) - top - y - h;
    return NSMakeRect(x, originY, MAX(w, 1), MAX(h, 1));
}

void *iptv_mpv_mac_create(void *raw_parent, int32_t x, int32_t y, int32_t w, int32_t h) {
    NSView *parent = (__bridge NSView *)raw_parent;
    if (!parent) return NULL;
    IptvMpvHostView *host = [[IptvMpvHostView alloc] initWithFrame:host_frame(parent, x, y, w, h)];
    host.wantsLayer = YES;
    host.layer.backgroundColor = NSColor.blackColor.CGColor;
    host.layer.masksToBounds = YES;
    [parent addSubview:host positioned:NSWindowAbove relativeTo:nil];
    return (__bridge_retained void *)host;
}

void iptv_mpv_mac_set_bounds(void *raw_host, int32_t x, int32_t y, int32_t w, int32_t h) {
    NSView *host = (__bridge NSView *)raw_host;
    if (host.superview) [host setFrame:host_frame(host.superview, x, y, w, h)];
}

void iptv_mpv_mac_set_holes(void *raw_host, const int32_t *rects, size_t count) {
    NSView *host = (__bridge NSView *)raw_host;
    if (!host) return;
    if (!count) {
        host.layer.mask = nil;
        return;
    }
    CGFloat height = NSHeight(host.bounds);
    CGMutablePathRef path = CGPathCreateMutable();
    CGPathAddRect(path, NULL, host.bounds);
    for (size_t i = 0; i < count; ++i) {
        const int32_t *r = rects + i * 4;
        CGFloat originY = host.layer.isGeometryFlipped ? r[1] : height - r[1] - r[3];
        CGPathAddRect(path, NULL, CGRectMake(r[0], originY, r[2], r[3]));
    }
    CAShapeLayer *mask = [CAShapeLayer layer];
    mask.frame = host.bounds;
    mask.path = path;
    mask.fillRule = kCAFillRuleEvenOdd;
    host.layer.mask = mask;
    CGPathRelease(path);
}

void iptv_mpv_mac_destroy(void *raw_host) {
    IptvMpvHostView *host = (__bridge_transfer IptvMpvHostView *)raw_host;
    [host removeFromSuperview];
}
