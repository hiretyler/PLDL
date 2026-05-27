// PLDL desktop wrapper — targets Tauri 2.x.
//
// On startup we spawn the bundled `pldl-server` sidecar (a single-file Node
// executable that runs the Express API on http://localhost:3001), pipe its
// stdout/stderr to our own log, and stash the child handle in managed state so
// we can kill it deterministically when the app exits. The webview just loads
// the bundled index.html, which polls the server and renders its own
// preparing/connected badge — so we do NOT block window creation on the server.

use std::sync::Mutex;

use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Holds the running sidecar child so it can be terminated on exit.
#[derive(Default)]
struct SidecarState(Mutex<Option<CommandChild>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(SidecarState::default())
        .setup(|app| {
            // Build the sidecar command. `sidecar()` resolves the platform
            // binary (e.g. binaries/pldl-server-aarch64-apple-darwin) declared
            // in tauri.conf.json's bundle.externalBin.
            let (mut rx, child) = app
                .shell()
                .sidecar("pldl-server")?
                .spawn()?;

            // Store the child so we can kill it on shutdown.
            let state = app.state::<SidecarState>();
            *state.0.lock().expect("sidecar state poisoned") = Some(child);

            // Drain the event stream on a background task so the server's
            // stdout/stderr is surfaced in our logs and the pipe never blocks.
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            println!("[pldl-server] {}", String::from_utf8_lossy(&line).trim_end());
                        }
                        CommandEvent::Stderr(line) => {
                            eprintln!("[pldl-server] {}", String::from_utf8_lossy(&line).trim_end());
                        }
                        CommandEvent::Error(err) => {
                            eprintln!("[pldl-server] error: {}", err);
                        }
                        CommandEvent::Terminated(payload) => {
                            eprintln!("[pldl-server] terminated: {:?}", payload);
                            break;
                        }
                        _ => {}
                    }
                }
            });

            Ok(())
        })
        // Kill the sidecar when the main window is closed by the user.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                kill_sidecar(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building PLDL")
        // Belt-and-suspenders: also kill on the app-level Exit event, which
        // covers shutdown paths that don't emit a window CloseRequested.
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                kill_sidecar(app_handle);
            }
        });
}

/// Take the child out of state (if present) and kill it. Idempotent.
fn kill_sidecar(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<SidecarState>() {
        if let Some(child) = state.0.lock().expect("sidecar state poisoned").take() {
            let _ = child.kill();
        }
    }
}
