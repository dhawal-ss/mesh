fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(application_commands())),
    )
    .expect("failed to build the Mesh Tauri application manifest")
}

/// Select the command inventory that matches the compiled renderer/backend pair.
/// The default Matrix build cannot acquire legacy LAN commands simply because a
/// second handler exists elsewhere in lib.rs.
fn application_commands() -> &'static [&'static str] {
    const MATRIX_INVENTORY: &str = include_str!("permissions/mesh-main.toml");
    const LEGACY_INVENTORY: &str = include_str!("permissions/mesh-legacy.toml");
    let inventories: &[&'static str] = if cfg!(feature = "legacy-p2p") {
        &[MATRIX_INVENTORY, LEGACY_INVENTORY]
    } else {
        &[MATRIX_INVENTORY]
    };
    let commands = inventories
        .iter()
        .flat_map(|inventory| inventory.lines())
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
