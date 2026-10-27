fn main() {
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rerun-if-changed=src/mpv_window_mac.m");
        cc::Build::new()
            .file("src/mpv_window_mac.m")
            .flag("-fobjc-arc")
            .compile("iptv_mpv_window_mac");
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rustc-link-lib=framework=QuartzCore");
    }
    tauri_build::build();
}
