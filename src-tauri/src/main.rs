// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Targets Tauri 2.x. All app logic lives in lib.rs (idiomatic v2 layout).
fn main() {
    pldl_lib::run()
}
