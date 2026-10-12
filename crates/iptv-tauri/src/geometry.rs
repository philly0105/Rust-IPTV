//! Pure window geometry in physical pixels: keeping a window on the monitors
//! that exist now, the picture-in-picture drag, and the PiP aspect lock.
//!
//! Everything here is platform independent and unit tested; the Win32 and
//! Tauri glue lives in `lib.rs`, `mpv_window.rs` and `pip_window.rs`.

/// A rectangle in physical pixels (screen space).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Rect {
    pub const fn new(x: i32, y: i32, width: i32, height: i32) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    fn right(&self) -> i64 {
        i64::from(self.x) + i64::from(self.width)
    }

    fn bottom(&self) -> i64 {
        i64::from(self.y) + i64::from(self.height)
    }

    fn area(&self) -> i64 {
        i64::from(self.width.max(0)) * i64::from(self.height.max(0))
    }

    fn is_empty(&self) -> bool {
        self.width <= 0 || self.height <= 0
    }

    /// Area shared with `other` (0 when they do not touch).
    fn overlap(&self, other: &Rect) -> i64 {
        let w = self.right().min(other.right()) - i64::from(self.x.max(other.x));
        let h = self.bottom().min(other.bottom()) - i64::from(self.y.max(other.y));
        w.max(0) * h.max(0)
    }

    /// Squared distance between the centres, in doubled coordinates so it
    /// stays integral.
    fn centre_distance(&self, other: &Rect) -> i128 {
        let dx = (2 * i128::from(self.x) + i128::from(self.width))
            - (2 * i128::from(other.x) + i128::from(other.width));
        let dy = (2 * i128::from(self.y) + i128::from(self.height))
            - (2 * i128::from(other.y) + i128::from(other.height));
        dx * dx + dy * dy
    }

    /// Whether this rectangle covers all of `other`.
    pub fn contains(&self, other: &Rect) -> bool {
        self.x <= other.x
            && self.y <= other.y
            && self.right() >= other.right()
            && self.bottom() >= other.bottom()
    }
}

/// Clamps `v` into `[lo, hi]`, preferring `lo` when the range is empty (the
/// window is larger than the area: its top-left edge stays reachable).
fn clamp_low(v: i64, lo: i64, hi: i64) -> i64 {
    v.min(hi).max(lo)
}

fn to_i32(v: i64) -> i32 {
    v.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
}

/// Where a restored window must go so all of it is on a monitor that exists
/// now.
///
/// `rect` is the window's outer rectangle and `areas` the monitors' work
/// areas (primary first). `slack` is how far the frame may hang over an edge:
/// Windows 10/11 frames carry invisible resize borders (about 7 px at 100 %)
/// on the left, right and bottom, so a window snapped to an edge reports an
/// outer rectangle slightly larger than the work area.
///
/// The window is left alone when every visible part of it is on some work
/// area, even across two monitors. Otherwise it moves onto the work area it
/// overlaps most, or, when it overlaps none (its monitor was unplugged), the
/// one nearest to it, and shrinks to fit when it is larger than that area.
pub fn place_on_screen(rect: Rect, areas: &[Rect], slack: i32) -> Rect {
    let areas: Vec<Rect> = areas.iter().copied().filter(|a| !a.is_empty()).collect();
    if areas.is_empty() || rect.is_empty() {
        return rect;
    }
    let slack = slack.max(0);
    // The part of the window that must be visible: the frame minus its
    // invisible borders (the top edge has none).
    let visible = Rect::new(
        rect.x.saturating_add(slack),
        rect.y,
        (rect.width - 2 * slack).max(1),
        (rect.height - slack).max(1),
    );
    let on_screen: i64 = areas.iter().map(|a| visible.overlap(a)).sum();
    if on_screen >= visible.area() {
        return rect;
    }
    let target = areas
        .iter()
        .copied()
        .max_by_key(|a| (i128::from(rect.overlap(a)), -rect.centre_distance(a)))
        .unwrap_or(areas[0]);
    let width = i64::from(rect.width).min(i64::from(target.width) + 2 * i64::from(slack));
    let height = i64::from(rect.height).min(i64::from(target.height) + i64::from(slack));
    let x = clamp_low(
        i64::from(rect.x),
        i64::from(target.x) - i64::from(slack),
        target.right() + i64::from(slack) - width,
    );
    let y = clamp_low(
        i64::from(rect.y),
        i64::from(target.y),
        target.bottom() + i64::from(slack) - height,
    );
    Rect::new(to_i32(x), to_i32(y), to_i32(width), to_i32(height))
}

/// Moves `rect` (keeping its size) so it lies inside `area`; a rectangle
/// larger than the area keeps its top-left corner on it.
pub fn clamp_into(rect: Rect, area: Rect) -> Rect {
    let x = clamp_low(
        i64::from(rect.x),
        i64::from(area.x),
        area.right() - i64::from(rect.width),
    );
    let y = clamp_low(
        i64::from(rect.y),
        i64::from(area.y),
        area.bottom() - i64::from(rect.height),
    );
    Rect::new(to_i32(x), to_i32(y), rect.width, rect.height)
}

/// Pulls `rect` flush against any edge of `area` it is within `threshold`
/// pixels of, so a dragged PiP window docks neatly into a corner.
pub fn snap_to_edges(rect: Rect, area: Rect, threshold: i32) -> Rect {
    let t = i64::from(threshold.max(0));
    let mut out = rect;
    if (i64::from(rect.x) - i64::from(area.x)).abs() <= t {
        out.x = area.x;
    } else if (rect.right() - area.right()).abs() <= t {
        out.x = to_i32(area.right() - i64::from(rect.width));
    }
    if (i64::from(rect.y) - i64::from(area.y)).abs() <= t {
        out.y = area.y;
    } else if (rect.bottom() - area.bottom()).abs() <= t {
        out.y = to_i32(area.bottom() - i64::from(rect.height));
    }
    out
}

/// Window position while it is dragged: where it started plus how far the
/// cursor moved since.
pub fn drag_position(
    window: (i32, i32),
    cursor_start: (i32, i32),
    cursor: (i32, i32),
) -> (i32, i32) {
    let dx = i64::from(cursor.0) - i64::from(cursor_start.0);
    let dy = i64::from(cursor.1) - i64::from(cursor_start.1);
    (
        to_i32(i64::from(window.0) + dx),
        to_i32(i64::from(window.1) + dy),
    )
}

/// Keeps a `cx` x `cy` size at `aspect` (width / height) by deriving the
/// height from the width. Sizes already within a pixel of the ratio, empty
/// sizes and invalid ratios pass through unchanged.
pub fn enforce_aspect(cx: i32, cy: i32, aspect: f64) -> (i32, i32) {
    if cx <= 0 || cy <= 0 || !aspect.is_finite() || aspect <= 0.0 {
        return (cx, cy);
    }
    let want = (f64::from(cx) / aspect).round();
    if !(1.0..=f64::from(i32::MAX)).contains(&want) || (want - f64::from(cy)).abs() <= 1.0 {
        return (cx, cy);
    }
    (cx, want as i32)
}

/// How the hidden restored window is put back on a monitor
/// (`fit_restored_window`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FitMove {
    /// Already on screen: nothing to do.
    Stay,
    /// tao's `set_position`, plus `set_size` when `resize`: a normal window.
    Tao { resize: bool },
    /// The whole outer rectangle in one native `SetWindowPos`, for a window
    /// restored maximized. tao's setters clear its maximized flag, and on a
    /// hidden window that un-maximize is a `ShowWindow(SW_RESTORE)`, which
    /// shows it early and leaves it un-maximized. `SetWindowPos` neither
    /// shows it nor touches tao's flags, so the window still maximizes on show
    /// (`style_before_show`), on the monitor it was moved to.
    Native,
}

/// Picks the move for a restored window at `rect` that belongs at `placed`.
pub fn fit_move(rect: Rect, placed: Rect, maximized: bool) -> FitMove {
    if placed == rect {
        FitMove::Stay
    } else if maximized {
        FitMove::Native
    } else {
        FitMove::Tao {
            resize: placed.width != rect.width || placed.height != rect.height,
        }
    }
}

/// `WS_MAXIMIZE` (winuser.h).
pub const WS_MAXIMIZE: u32 = 0x0100_0000;

/// The window style to write just before a hidden window is shown, or None
/// to leave it. tao "maximizes" a hidden window (the window-state plugin
/// restoring a maximized window, `unstick_fullscreen_size`) by writing
/// `WS_MAXIMIZE` into its style without sizing it: it skips `ShowWindow` to
/// avoid a flash. Windows then takes the window as already maximized, so the
/// `ShowWindow(SW_MAXIMIZE)` tao sends when the window is shown does not size
/// it either, and it comes up zoomed at its restored rectangle. Without the
/// bit, that same call does a real maximize to the work area. A visible
/// window is left alone: its maximize really happened.
pub fn style_before_show(style: u32, visible: bool) -> Option<u32> {
    (!visible && style & WS_MAXIMIZE != 0).then_some(style & !WS_MAXIMIZE)
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEFT: Rect = Rect::new(0, 0, 1920, 1040);
    const RIGHT: Rect = Rect::new(1920, 0, 2560, 1400);
    const SLACK: i32 = 8;

    // WS_OVERLAPPEDWINDOW | WS_CLIPSIBLINGS, as tao builds a framed window.
    const FRAMED: u32 = 0x00CF_0000 | 0x0400_0000;

    #[test]
    fn a_hidden_window_flagged_maximized_is_unflagged_so_showing_it_really_maximizes() {
        // Quit maximized, relaunch: the plugin's maximize on the hidden window
        // left WS_MAXIMIZE over a 1308x847 rect (IsZoomed true, screen not covered).
        assert_eq!(style_before_show(FRAMED | WS_MAXIMIZE, false), Some(FRAMED));
    }

    #[test]
    fn a_window_restored_maximized_and_off_screen_moves_natively_so_it_stays_maximized_and_hidden()
    {
        let saved = Rect::new(2400, 100, 1308, 847); // on a monitor that is gone
        let placed = place_on_screen(saved, &[LEFT], SLACK);
        assert_ne!(placed, saved);
        assert_eq!(fit_move(saved, placed, true), FitMove::Native);
    }

    #[test]
    fn a_normal_window_moves_with_tao_and_an_on_screen_one_stays() {
        let on = Rect::new(100, 50, 1296, 839);
        assert_eq!(fit_move(on, on, true), FitMove::Stay);
        assert_eq!(fit_move(on, on, false), FitMove::Stay);
        let off = Rect::new(2400, 100, 1296, 839);
        assert_eq!(
            fit_move(off, place_on_screen(off, &[LEFT], SLACK), false),
            FitMove::Tao { resize: false }
        );
        let huge = Rect::new(0, 0, 3840, 2100);
        assert_eq!(
            fit_move(huge, place_on_screen(huge, &[LEFT], SLACK), false),
            FitMove::Tao { resize: true }
        );
    }

    #[test]
    fn a_shown_or_unmaximized_window_is_left_alone() {
        assert_eq!(
            style_before_show(FRAMED | WS_MAXIMIZE, true),
            None,
            "a real maximize"
        );
        assert_eq!(style_before_show(FRAMED, false), None);
        assert_eq!(style_before_show(FRAMED, true), None);
    }

    #[test]
    fn a_window_fully_on_screen_stays_put() {
        let r = Rect::new(100, 50, 1296, 839);
        assert_eq!(place_on_screen(r, &[LEFT], SLACK), r);
    }

    #[test]
    fn invisible_borders_hanging_over_the_edge_are_fine() {
        // Snapped to the left half: the frame starts 7 px left of the screen.
        let r = Rect::new(-7, 0, 974, 1047);
        assert_eq!(place_on_screen(r, &[LEFT], SLACK), r);
    }

    #[test]
    fn a_window_across_two_monitors_stays_put() {
        let r = Rect::new(1500, 100, 1000, 700);
        assert_eq!(place_on_screen(r, &[LEFT, RIGHT], SLACK), r);
    }

    #[test]
    fn a_window_on_an_unplugged_monitor_lands_fully_on_the_nearest_one() {
        // Saved on the right monitor, which is gone now.
        let r = Rect::new(2400, 300, 1296, 839);
        let placed = place_on_screen(r, &[LEFT], SLACK);
        assert_eq!(
            placed,
            Rect::new(1920 + SLACK - 1296, 1040 + SLACK - 839, 1296, 839)
        );
        let visible = Rect::new(
            placed.x + SLACK,
            placed.y,
            placed.width - 2 * SLACK,
            placed.height - SLACK,
        );
        assert!(LEFT.contains(&visible));
    }

    #[test]
    fn a_window_on_a_monitor_left_of_the_primary_comes_back() {
        let r = Rect::new(-1800, -200, 1296, 839);
        let placed = place_on_screen(r, &[LEFT], SLACK);
        assert_eq!((placed.x, placed.y), (-SLACK, 0));
    }

    #[test]
    fn a_window_bigger_than_the_remaining_monitor_shrinks_to_fit() {
        // A 4K-sized window from a monitor that is gone.
        let r = Rect::new(4000, 0, 3000, 1900);
        let placed = place_on_screen(r, &[LEFT], SLACK);
        assert_eq!(placed, Rect::new(-SLACK, 0, 1920 + 2 * SLACK, 1040 + SLACK));
    }

    #[test]
    fn a_title_bar_above_the_screen_moves_down() {
        let r = Rect::new(100, -300, 1296, 839);
        assert_eq!(
            place_on_screen(r, &[LEFT], SLACK),
            Rect::new(100, 0, 1296, 839)
        );
    }

    #[test]
    fn partly_off_screen_goes_to_the_monitor_it_overlaps_most() {
        // Mostly on the right monitor, hanging off its bottom.
        let r = Rect::new(2200, 1000, 1296, 839);
        let placed = place_on_screen(r, &[LEFT, RIGHT], SLACK);
        assert_eq!(placed, Rect::new(2200, 1400 + SLACK - 839, 1296, 839));
    }

    #[test]
    fn nothing_known_means_no_change() {
        let r = Rect::new(-9999, -9999, 10, 10);
        assert_eq!(place_on_screen(r, &[], SLACK), r);
        assert_eq!(place_on_screen(r, &[Rect::new(0, 0, 0, 0)], SLACK), r);
        let empty = Rect::new(5, 5, 0, 0);
        assert_eq!(place_on_screen(empty, &[LEFT], SLACK), empty);
    }

    #[test]
    fn extreme_coordinates_do_not_overflow() {
        let r = Rect::new(i32::MAX - 10, i32::MIN + 10, i32::MAX, i32::MAX);
        let placed = place_on_screen(r, &[LEFT], SLACK);
        assert!(placed.width <= 1920 + 2 * SLACK && placed.height <= 1040 + SLACK);
        assert_eq!(drag_position((i32::MAX, 0), (0, 0), (100, 0)).0, i32::MAX);
        assert_eq!(enforce_aspect(i32::MAX, 1, 1e-9), (i32::MAX, 1));
    }

    #[test]
    fn the_pip_window_stays_inside_the_work_area_while_dragged() {
        let pip = Rect::new(1700, 900, 480, 270);
        assert_eq!(clamp_into(pip, LEFT), Rect::new(1440, 770, 480, 270));
        assert_eq!(
            clamp_into(Rect::new(-50, -20, 480, 270), LEFT),
            Rect::new(0, 0, 480, 270)
        );
        // Larger than the area: the top-left corner stays reachable.
        assert_eq!(
            clamp_into(Rect::new(-50, -20, 3000, 2000), LEFT),
            Rect::new(0, 0, 3000, 2000)
        );
    }

    #[test]
    fn the_pip_window_snaps_to_nearby_edges_only() {
        let near_corner = Rect::new(1430, 760, 480, 270);
        assert_eq!(
            snap_to_edges(near_corner, LEFT, 16),
            Rect::new(1440, 770, 480, 270)
        );
        let near_top_left = Rect::new(12, 9, 480, 270);
        assert_eq!(
            snap_to_edges(near_top_left, LEFT, 16),
            Rect::new(0, 0, 480, 270)
        );
        let middle = Rect::new(600, 400, 480, 270);
        assert_eq!(snap_to_edges(middle, LEFT, 16), middle);
    }

    #[test]
    fn dragging_moves_the_window_by_the_cursor_delta() {
        assert_eq!(
            drag_position((1400, 760), (1500, 800), (1300, 650)),
            (1200, 610)
        );
        assert_eq!(drag_position((10, 10), (0, 0), (0, 0)), (10, 10));
    }

    #[test]
    fn the_aspect_lock_derives_the_height_from_the_width() {
        let ratio = 16.0 / 9.0;
        assert_eq!(enforce_aspect(960, 1040, ratio), (960, 540)); // half-screen snap
        assert_eq!(enforce_aspect(640, 361, ratio), (640, 361)); // within a pixel
        assert_eq!(enforce_aspect(0, 0, ratio), (0, 0));
        assert_eq!(enforce_aspect(640, 100, f64::NAN), (640, 100));
        assert_eq!(enforce_aspect(640, 100, 0.0), (640, 100));
    }

    #[test]
    fn contains_is_inclusive() {
        assert!(LEFT.contains(&LEFT));
        assert!(Rect::new(-8, -8, 1936, 1056).contains(&LEFT));
        assert!(!Rect::new(0, 0, 1919, 1040).contains(&LEFT));
    }
}
