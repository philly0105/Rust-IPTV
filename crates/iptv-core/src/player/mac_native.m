#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#import <OpenGL/OpenGL.h>
#include <dlfcn.h>
#include <math.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

// The small part of libmpv's stable C ABI used here. Loading at runtime keeps
// a browser-only/core build independent of a Homebrew installation.
typedef struct mpv_handle mpv_handle;
typedef struct mpv_render_context mpv_render_context;
typedef union { char *string; int flag; int64_t int64; double double_; struct mpv_node_list *list; } mpv_value;
typedef struct mpv_node { mpv_value u; int format; } mpv_node;
typedef struct mpv_node_list { int num; mpv_node *values; char **keys; } mpv_node_list;
typedef struct { int event_id; int error; uint64_t reply_userdata; void *data; } mpv_event;
typedef struct { const char *name; int format; void *data; } mpv_event_property;
typedef struct { int reason; int error; } mpv_event_end_file;
typedef struct { int num_args; char **args; } mpv_event_client_message;
typedef struct { int type; void *data; } mpv_render_param;

enum { F_NONE, F_STRING, F_OSD_STRING, F_FLAG, F_INT64, F_DOUBLE, F_NODE, F_ARRAY, F_MAP };
enum { E_NONE, E_SHUTDOWN, E_LOG, E_GET_REPLY, E_SET_REPLY, E_CMD_REPLY, E_START, E_END, E_LOADED };
enum { E_CLIENT_MESSAGE = 16, E_PROPERTY_CHANGE = 22 };
enum { R_INVALID = 0, R_API_TYPE = 1, R_OPENGL_INIT = 2, R_OPENGL_FBO = 3,
       R_FLIP_Y = 4, R_SW_SIZE = 17, R_SW_FORMAT = 18, R_SW_STRIDE = 19, R_SW_POINTER = 20 };

typedef struct { void *(*get_proc_address)(void *, const char *); void *ctx; } mpv_opengl_init_params;
typedef struct { int fbo, w, h, internal_format; } mpv_opengl_fbo;

// AppKit owns the view. The render thread owns all GL and libmpv drawing.
@interface IptvMpvGLView : NSOpenGLView
@end
@implementation IptvMpvGLView
- (BOOL)isFlipped { return YES; }
- (NSView *)hitTest:(NSPoint)point { return nil; }
- (void)drawRect:(NSRect)dirtyRect { (void)dirtyRect; }
@end

static void *gl_proc_address(void *ctx, const char *name) {
    (void)ctx;
    CFStringRef symbol = CFStringCreateWithCString(kCFAllocatorDefault, name, kCFStringEncodingASCII);
    if (!symbol) return NULL;
    void *address = CFBundleGetFunctionPointerForName(CFBundleGetBundleWithIdentifier(CFSTR("com.apple.opengl")), symbol);
    CFRelease(symbol);
    return address;
}

typedef struct {
    void *library;
    mpv_handle *(*create)(void);
    int (*set_option_string)(mpv_handle *, const char *, const char *);
    int (*initialize)(mpv_handle *);
    void (*terminate_destroy)(mpv_handle *);
    int (*command_node)(mpv_handle *, const mpv_node *, mpv_node *);
    int (*set_property)(mpv_handle *, const char *, int, void *);
    int (*get_property)(mpv_handle *, const char *, int, void *);
    int (*observe_property)(mpv_handle *, uint64_t, const char *, int);
    mpv_event *(*wait_event)(mpv_handle *, double);
    void (*free_node_contents)(mpv_node *);
    const char *(*error_string)(int);
    int (*render_create)(mpv_render_context **, mpv_handle *, mpv_render_param *);
    void (*render_set_update_callback)(mpv_render_context *, void (*)(void *), void *);
    uint64_t (*render_update)(mpv_render_context *);
    int (*render)(mpv_render_context *, mpv_render_param *);
    void (*render_free)(mpv_render_context *);
} MpvApi;

typedef struct {
    MpvApi api;
    mpv_handle *handle;
    mpv_render_context *render;
    NSView *host;
    IptvMpvGLView *gl_view;
    NSOpenGLContext *gl_context;
    int gpu;
    int last_width;
    int last_height;
    pthread_mutex_t redraw_mutex;
    pthread_cond_t redraw_cond;
    int redraw_mutex_ready;
    int redraw_cond_ready;
    int redraw_pending;
} NativeSession;

// Called by libmpv on an arbitrary thread. It only wakes the renderer; mpv
// render API calls must happen on the render thread, never in this callback.
static void wake_renderer(void *context) {
    NativeSession *s = context;
    pthread_mutex_lock(&s->redraw_mutex);
    s->redraw_pending = 1;
    pthread_cond_signal(&s->redraw_cond);
    pthread_mutex_unlock(&s->redraw_mutex);
}

// A timed wake also picks up a view resize when video is paused or idle.
void iptv_mpv_mac_wait_frame(void *raw_session, int timeout_ms) {
    NativeSession *s = raw_session;
    struct timespec until;
    clock_gettime(CLOCK_REALTIME, &until);
    until.tv_sec += timeout_ms / 1000;
    until.tv_nsec += (timeout_ms % 1000) * 1000000L;
    if (until.tv_nsec >= 1000000000L) { until.tv_sec++; until.tv_nsec -= 1000000000L; }
    pthread_mutex_lock(&s->redraw_mutex);
    if (!s->redraw_pending) pthread_cond_timedwait(&s->redraw_cond, &s->redraw_mutex, &until);
    s->redraw_pending = 0;
    pthread_mutex_unlock(&s->redraw_mutex);
}

static char *json_string(id object) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:object options:NSJSONWritingFragmentsAllowed error:nil];
    if (!data) return strdup("null");
    char *out = malloc(data.length + 1);
    memcpy(out, data.bytes, data.length);
    out[data.length] = 0;
    return out;
}

static NSString *safe_string(const char *text) {
    return text ? ([NSString stringWithUTF8String:text] ?: @"") : @"";
}

static id json_value(const mpv_node *node) {
    if (!node) return NSNull.null;
    switch (node->format) {
        case F_STRING: return safe_string(node->u.string);
        case F_FLAG: return node->u.flag ? @YES : @NO;
        case F_INT64: return @(node->u.int64);
        case F_DOUBLE: return isfinite(node->u.double_) ? @(node->u.double_) : NSNull.null;
        case F_ARRAY: {
            NSMutableArray *values = [NSMutableArray array];
            mpv_node_list *list = node->u.list;
            if (list) for (int i = 0; i < list->num; ++i) [values addObject:json_value(&list->values[i])];
            return values;
        }
        case F_MAP: {
            NSMutableDictionary *values = [NSMutableDictionary dictionary];
            mpv_node_list *list = node->u.list;
            if (list) for (int i = 0; i < list->num; ++i) values[safe_string(list->keys[i])] = json_value(&list->values[i]);
            return values;
        }
        default: return NSNull.null;
    }
}

static mpv_node make_node(id value) {
    mpv_node node = {0};
    if ([value isKindOfClass:NSString.class]) {
        node.format = F_STRING;
        node.u.string = strdup([value UTF8String]);
    } else if ([value isKindOfClass:NSNumber.class]) {
        if (CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) {
            node.format = F_FLAG;
            node.u.flag = [value boolValue];
        } else if (strchr([[value stringValue] UTF8String], '.')) {
            node.format = F_DOUBLE;
            node.u.double_ = [value doubleValue];
        } else {
            node.format = F_INT64;
            node.u.int64 = [value longLongValue];
        }
    } else if ([value isKindOfClass:NSArray.class] || [value isKindOfClass:NSDictionary.class]) {
        BOOL map = [value isKindOfClass:NSDictionary.class];
        NSUInteger count = [value count];
        mpv_node_list *list = calloc(1, sizeof(*list));
        list->num = (int)count;
        list->values = calloc(MAX(count, 1), sizeof(mpv_node));
        if (map) {
            list->keys = calloc(MAX(count, 1), sizeof(char *));
            NSUInteger i = 0;
            for (NSString *key in value) {
                list->keys[i] = strdup(key.UTF8String);
                list->values[i++] = make_node(value[key]);
            }
        } else {
            for (NSUInteger i = 0; i < count; ++i) list->values[i] = make_node(value[i]);
        }
        node.format = map ? F_MAP : F_ARRAY;
        node.u.list = list;
    }
    return node;
}

static void release_node(mpv_node *node) {
    if (node->format == F_STRING) free(node->u.string);
    if (node->format == F_ARRAY || node->format == F_MAP) {
        mpv_node_list *list = node->u.list;
        for (int i = 0; i < list->num; ++i) {
            release_node(&list->values[i]);
            if (list->keys) free(list->keys[i]);
        }
        free(list->values); free(list->keys); free(list);
    }
}

static BOOL load_api(MpvApi *api) {
    const char *paths[] = {
        "@executable_path/../Frameworks/libmpv.2.dylib",
        "/opt/homebrew/lib/libmpv.2.dylib",
        "/usr/local/lib/libmpv.2.dylib",
        "libmpv.2.dylib",
        NULL
    };
    for (int i = 0; paths[i] && !api->library; ++i) api->library = dlopen(paths[i], RTLD_NOW | RTLD_LOCAL);
    if (!api->library) return NO;
#define LOAD(field, name) api->field = dlsym(api->library, name); if (!api->field) return NO
    LOAD(create, "mpv_create");
    LOAD(set_option_string, "mpv_set_option_string");
    LOAD(initialize, "mpv_initialize");
    LOAD(terminate_destroy, "mpv_terminate_destroy");
    LOAD(command_node, "mpv_command_node");
    LOAD(set_property, "mpv_set_property");
    LOAD(get_property, "mpv_get_property");
    LOAD(observe_property, "mpv_observe_property");
    LOAD(wait_event, "mpv_wait_event");
    LOAD(free_node_contents, "mpv_free_node_contents");
    LOAD(error_string, "mpv_error_string");
    LOAD(render_create, "mpv_render_context_create");
    LOAD(render_set_update_callback, "mpv_render_context_set_update_callback");
    LOAD(render_update, "mpv_render_context_update");
    LOAD(render, "mpv_render_context_render");
    LOAD(render_free, "mpv_render_context_free");
#undef LOAD
    return YES;
}

int iptv_mpv_mac_available(void) {
    MpvApi api = {0};
    BOOL available = load_api(&api);
    if (api.library) dlclose(api.library);
    return available;
}

void *iptv_mpv_mac_session_open(void *raw_host, const char *options_json, double volume, int muted, char **error) {
    NativeSession *session = calloc(1, sizeof(*session));
    NSData *input = nil;
    NSArray *options = nil;
    if (!load_api(&session->api)) {
        *error = strdup("libmpv.2.dylib is unavailable; install mpv to use embedded playback");
        if (session->api.library) dlclose(session->api.library);
        free(session);
        return NULL;
    }
    if (pthread_mutex_init(&session->redraw_mutex, NULL)) goto failed;
    session->redraw_mutex_ready = 1;
    if (pthread_cond_init(&session->redraw_cond, NULL)) goto failed;
    session->redraw_cond_ready = 1;
    session->host = (__bridge NSView *)raw_host;
    session->handle = session->api.create();
    if (!session->handle) goto failed;
    session->api.set_option_string(session->handle, "config", "no");
    session->api.set_option_string(session->handle, "terminal", "no");
    session->api.set_option_string(session->handle, "osc", "no");
    session->api.set_option_string(session->handle, "idle", "yes");
    session->api.set_option_string(session->handle, "keep-open", "yes");
    session->api.set_option_string(session->handle, "input-default-bindings", "no");
    session->api.set_option_string(session->handle, "input-vo-keyboard", "no");
    session->api.set_option_string(session->handle, "vo", "libmpv");
    session->api.set_option_string(session->handle, "hwdec", "auto-safe");
    char level[32]; snprintf(level, sizeof(level), "%.0f", volume);
    session->api.set_option_string(session->handle, "volume", level);
    session->api.set_option_string(session->handle, "mute", muted ? "yes" : "no");
    input = [safe_string(options_json) dataUsingEncoding:NSUTF8StringEncoding];
    options = [NSJSONSerialization JSONObjectWithData:input options:0 error:nil];
    if ([options isKindOfClass:NSArray.class]) {
        for (NSString *arg in options) {
            if (![arg isKindOfClass:NSString.class] || ![arg hasPrefix:@"--"]) continue;
            NSString *option = [arg substringFromIndex:2];
            NSRange equals = [option rangeOfString:@"="];
            NSString *name = equals.location == NSNotFound ? option : [option substringToIndex:equals.location];
            NSString *value = equals.location == NSNotFound ? @"yes" : [option substringFromIndex:equals.location + 1];
            if ([name isEqualToString:@"wid"] || [name isEqualToString:@"vo"] || [name isEqualToString:@"input-ipc-server"]) continue;
            session->api.set_option_string(session->handle, name.UTF8String, value.UTF8String);
        }
    }
    int status = session->api.initialize(session->handle);
    if (status < 0) goto failed;
    // The OpenGL render API keeps scaling and presentation on the GPU.
    // Keep the software path where a compatible CGL context cannot be created.
    dispatch_sync(dispatch_get_main_queue(), ^{
        NSOpenGLPixelFormatAttribute attributes[] = {
            NSOpenGLPFAOpenGLProfile, NSOpenGLProfileVersion3_2Core,
            NSOpenGLPFADoubleBuffer, NSOpenGLPFAAccelerated, 0
        };
        NSOpenGLPixelFormat *format = [[NSOpenGLPixelFormat alloc] initWithAttributes:attributes];
        if (!format) return;
        session->gl_view = [[IptvMpvGLView alloc] initWithFrame:session->host.bounds pixelFormat:format];
        if (!session->gl_view) return;
        session->gl_view.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        session->gl_view.wantsBestResolutionOpenGLSurface = YES;
        [session->host addSubview:session->gl_view];
        session->gl_context = session->gl_view.openGLContext;
    });
    if (session->gl_context) {
        [session->gl_context makeCurrentContext];
        mpv_opengl_init_params gl_init = {gl_proc_address, NULL};
        mpv_render_param gl_params[] = {
            {R_API_TYPE, "opengl"}, {R_OPENGL_INIT, &gl_init}, {R_INVALID, NULL}
        };
        status = session->api.render_create(&session->render, session->handle, gl_params);
        [NSOpenGLContext clearCurrentContext];
        session->gpu = status >= 0;
    }
    if (!session->gpu) {
        dispatch_sync(dispatch_get_main_queue(), ^{
            [session->gl_view removeFromSuperview];
            session->gl_view = nil;
            session->gl_context = nil;
        });
        mpv_render_param sw_params[] = {{R_API_TYPE, "sw"}, {R_INVALID, NULL}};
        status = session->api.render_create(&session->render, session->handle, sw_params);
    }
    if (status < 0) goto failed;
    NSLog(@"iptv mpv renderer: %@", session->gpu ? @"OpenGL" : @"software fallback");
    session->api.render_set_update_callback(session->render, wake_renderer, session);
    return session;
failed:
    *error = strdup("could not initialize the libmpv renderer");
    if (session->render) {
        if (session->gpu) [session->gl_context makeCurrentContext];
        session->api.render_free(session->render);
        if (session->gpu) [NSOpenGLContext clearCurrentContext];
    }
    if (session->gl_view) dispatch_sync(dispatch_get_main_queue(), ^{ [session->gl_view removeFromSuperview]; });
    if (session->handle) session->api.terminate_destroy(session->handle);
    if (session->redraw_cond_ready) pthread_cond_destroy(&session->redraw_cond);
    if (session->redraw_mutex_ready) pthread_mutex_destroy(&session->redraw_mutex);
    dlclose(session->api.library);
    free(session);
    return NULL;
}

char *iptv_mpv_mac_command(void *raw_session, const char *command_json) {
    NativeSession *s = raw_session;
    NSData *data = [safe_string(command_json) dataUsingEncoding:NSUTF8StringEncoding];
    NSArray *args = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if (![args isKindOfClass:NSArray.class] || !args.count) return json_string(@{@"error": @"invalid command", @"data": NSNull.null});
    if (![args[0] isKindOfClass:NSString.class]) return json_string(@{@"error": @"invalid command", @"data": NSNull.null});
    NSString *name = args[0];
    int status;
    id result = NSNull.null;
    if ([name isEqualToString:@"observe_property"] && args.count >= 3) {
        status = s->api.observe_property(s->handle, [args[1] unsignedLongLongValue], [args[2] UTF8String], F_NODE);
    } else if (([name isEqualToString:@"set_property"] || [name isEqualToString:@"set_property_string"]) && args.count >= 3) {
        mpv_node value = make_node(args[2]);
        if ([name isEqualToString:@"set_property_string"]) {
            NSString *string = [args[2] isKindOfClass:NSString.class] ? args[2] : [args[2] description];
            const char *text = string.UTF8String;
            status = s->api.set_property(s->handle, [args[1] UTF8String], F_STRING, &text);
        } else {
            status = s->api.set_property(s->handle, [args[1] UTF8String], F_NODE, &value);
        }
        release_node(&value);
    } else if (([name isEqualToString:@"get_property"] || [name isEqualToString:@"get_property_string"]) && args.count >= 2) {
        mpv_node value = {0};
        status = s->api.get_property(s->handle, [args[1] UTF8String], F_NODE, &value);
        if (status >= 0) result = json_value(&value);
        s->api.free_node_contents(&value);
    } else {
        mpv_node input = make_node(args);
        mpv_node output = {0};
        status = s->api.command_node(s->handle, &input, &output);
        if (status >= 0) result = json_value(&output);
        s->api.free_node_contents(&output);
        release_node(&input);
    }
    return json_string(@{@"error": status < 0 ? safe_string(s->api.error_string(status)) : @"success", @"data": result});
}

char *iptv_mpv_mac_next_event(void *raw_session) {
    NativeSession *s = raw_session;
    mpv_event *event = s->api.wait_event(s->handle, 0);
    if (!event || event->event_id == E_NONE) return NULL;
    switch (event->event_id) {
        case E_START: return json_string(@{@"event": @"start-file"});
        case E_LOADED: return json_string(@{@"event": @"file-loaded"});
        case E_END: {
            mpv_event_end_file *end = event->data;
            NSString *reason = end && end->reason == 4 ? @"error" : end && end->reason == 0 ? @"eof" : @"stop";
            return json_string(@{@"event": @"end-file", @"reason": reason, @"file_error": end ? safe_string(s->api.error_string(end->error)) : @""});
        }
        case E_PROPERTY_CHANGE: {
            mpv_event_property *property = event->data;
            id value = property && property->format == F_NODE ? json_value(property->data) : NSNull.null;
            return json_string(@{@"event": @"property-change", @"name": property ? safe_string(property->name) : @"", @"data": value});
        }
        case E_CLIENT_MESSAGE: {
            mpv_event_client_message *message = event->data;
            NSMutableArray *args = [NSMutableArray array];
            if (message) for (int i = 0; i < message->num_args; ++i) [args addObject:safe_string(message->args[i])];
            return json_string(@{@"event": @"client-message", @"args": args});
        }
        case E_SHUTDOWN: return json_string(@{@"event": @"shutdown"});
        default: return NULL;
    }
}

static void release_image_data(void *info, const void *bytes, size_t size) {
    (void)info; (void)size;
    free((void *)bytes);
}

int iptv_mpv_mac_render(void *raw_session) {
    NativeSession *s = raw_session;
    __block CGSize size = CGSizeZero;
    dispatch_sync(dispatch_get_main_queue(), ^{
        size = [s->host convertSizeToBacking:s->host.bounds.size];
        // AppKit requires a view-backed context to be updated on the main thread.
        if (s->gpu && ((int)size.width != s->last_width || (int)size.height != s->last_height))
            [s->gl_context update];
    });
    int width = (int)size.width, height = (int)size.height;
    if (width <= 0 || height <= 0 || width > 8192 || height > 8192) return 0;
    if (s->gpu) {
        CGLContextObj cgl = s->gl_context.CGLContextObj;
        CGLLockContext(cgl);
        [s->gl_context makeCurrentContext];
        uint64_t updates = s->api.render_update(s->render);
        if (!(updates & 1) && width == s->last_width && height == s->last_height) {
            [NSOpenGLContext clearCurrentContext];
            CGLUnlockContext(cgl);
            return 0;
        }
        s->last_width = width;
        s->last_height = height;
        mpv_opengl_fbo fbo = {0, width, height, 0};
        int flip_y = 1;
        mpv_render_param params[] = {
            {R_OPENGL_FBO, &fbo}, {R_FLIP_Y, &flip_y}, {R_INVALID, NULL}
        };
        int status = s->api.render(s->render, params);
        if (status >= 0) [s->gl_context flushBuffer];
        [NSOpenGLContext clearCurrentContext];
        CGLUnlockContext(cgl);
        return status;
    }
    uint64_t updates = s->api.render_update(s->render);
    if (!(updates & 1) && width == s->last_width && height == s->last_height) return 0;
    s->last_width = width;
    s->last_height = height;
    size_t stride = ((size_t)width * 4 + 63) & ~(size_t)63;
    void *pixels = NULL;
    if (posix_memalign(&pixels, 64, stride * height)) return -1;
    int dimensions[] = {width, height};
    char format[] = "rgb0";
    mpv_render_param params[] = {
        {R_SW_SIZE, dimensions}, {R_SW_FORMAT, format}, {R_SW_STRIDE, &stride},
        {R_SW_POINTER, pixels}, {R_INVALID, NULL}
    };
    int status = s->api.render(s->render, params);
    if (status < 0) { free(pixels); return status; }
    CGDataProviderRef provider = CGDataProviderCreateWithData(NULL, pixels, stride * height, release_image_data);
    CGColorSpaceRef color = CGColorSpaceCreateDeviceRGB();
    CGImageRef image = CGImageCreate(width, height, 8, 32, stride, color,
        kCGBitmapByteOrderDefault | kCGImageAlphaNoneSkipLast, provider, NULL, false, kCGRenderingIntentDefault);
    CGColorSpaceRelease(color);
    CGDataProviderRelease(provider);
    if (!image) return -1;
    NSView *host = s->host;
    dispatch_async(dispatch_get_main_queue(), ^{
        host.layer.contents = (__bridge id)image;
        CGImageRelease(image);
    });
    return 0;
}

void iptv_mpv_mac_session_close(void *raw_session) {
    NativeSession *s = raw_session;
    if (!s) return;
    if (s->render) {
        if (s->gpu) [s->gl_context makeCurrentContext];
        s->api.render_set_update_callback(s->render, NULL, NULL);
        s->api.render_free(s->render);
        if (s->gpu) [NSOpenGLContext clearCurrentContext];
    }
    if (s->handle) s->api.terminate_destroy(s->handle);
    if (s->gl_view) dispatch_sync(dispatch_get_main_queue(), ^{ [s->gl_view removeFromSuperview]; });
    pthread_cond_destroy(&s->redraw_cond);
    pthread_mutex_destroy(&s->redraw_mutex);
    if (s->api.library) dlclose(s->api.library);
    free(s);
}

void iptv_mpv_mac_free(char *text) { free(text); }
