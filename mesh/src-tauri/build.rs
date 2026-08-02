fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(application_commands())),
    )
    .expect("failed to build the Mesh Tauri application manifest")
}

/// Keep one reviewed inventory for every renderer-callable application command.
/// Tauri otherwise permits every registered command to every WebView by default.
/// The capability references the `mesh-main` permission defined by this same
/// file, so a newly registered command stays unavailable until the inventory and
/// IPC contract are deliberately updated together.
fn application_commands() -> &'static [&'static str] {
    const INVENTORY: &str = include_str!("permissions/mesh-main.toml");
    let commands = INVENTORY
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            line.strip_prefix('"')
                .and_then(|value| value.strip_suffix(","))
                .and_then(|value| value.strip_suffix('"'))
        })
        .collect::<Vec<_>>();

    assert!(
        !commands.is_empty(),
        "Mesh application command inventory is empty"
    );
    Box::leak(commands.into_boxed_slice())
}
