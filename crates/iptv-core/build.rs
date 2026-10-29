fn main() {
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rerun-if-changed=src/player/mac_native.m");
        cc::Build::new()
            .file("src/player/mac_native.m")
            .flag("-fobjc-arc")
            // libmpv's macOS GPU render API uses CGL; AppKit deprecates its
            // OpenGL wrappers but does not provide a Metal render API for mpv.
            .flag("-Wno-deprecated-declarations")
            .compile("iptv_mpv_native_mac");
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rustc-link-lib=framework=QuartzCore");
        println!("cargo:rustc-link-lib=framework=OpenGL");
    }
}
