//! Identity avatar colour selection.
//!
//! Author identity colour used to be a raw 24-bit hash (`#rrggbb`) written
//! straight into a renderer style attribute. That is a uniform sample of the
//! whole RGB cube, so a large share of accounts landed on colours that fail
//! WCAG contrast against the app canvas, and a few were effectively invisible.
//!
//! Rust now selects from the ten curated avatar tokens authored in
//! `src/styles/globals.css` (`--avatar-sand` through `--avatar-cyan`) instead
//! of emitting a colour. The renderer resolves the token, so contrast is
//! clamped in exactly one place, per theme, and an out-of-gamut identity
//! colour is structurally impossible on this side of the boundary.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// One of the curated `--avatar-*` identity tokens.
///
/// The serialized form is the bare token suffix (`"sand"`, `"blue"`, ...).
/// The DTO field still carries [`AvatarPalette::css_var`] so the existing
/// renderer keeps working unchanged; see `css_var` for the migration note.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AvatarPalette {
    Sand,
    Blue,
    Green,
    Red,
    Violet,
    Orange,
    Pink,
    Emerald,
    Yellow,
    Cyan,
}

/// Every selectable token, in a fixed order. Selection is an index into this
/// array, so adding a token is a deliberate, reviewable change.
pub const AVATAR_PALETTE: [AvatarPalette; 10] = [
    AvatarPalette::Sand,
    AvatarPalette::Blue,
    AvatarPalette::Green,
    AvatarPalette::Red,
    AvatarPalette::Violet,
    AvatarPalette::Orange,
    AvatarPalette::Pink,
    AvatarPalette::Emerald,
    AvatarPalette::Yellow,
    AvatarPalette::Cyan,
];

/// Used when no seed is available. Never a free colour.
pub const DEFAULT_AVATAR_PALETTE: AvatarPalette = AvatarPalette::Sand;

impl AvatarPalette {
    /// Bare token suffix, matching the `--avatar-<token>` custom property.
    pub const fn token(self) -> &'static str {
        match self {
            Self::Sand => "sand",
            Self::Blue => "blue",
            Self::Green => "green",
            Self::Red => "red",
            Self::Violet => "violet",
            Self::Orange => "orange",
            Self::Pink => "pink",
            Self::Emerald => "emerald",
            Self::Yellow => "yellow",
            Self::Cyan => "cyan",
        }
    }

    /// The wire value carried by `avatarColor` DTO fields.
    ///
    /// This is a reference to a design token, not a colour: the renderer
    /// resolves it per theme. It is the form the renderer's own Matrix
    /// identity helper already emits, which is why the switch away from raw
    /// hex needs no renderer change to land. When `Avatar` grows an explicit
    /// token allowlist the wire value can become [`AvatarPalette::token`]
    /// without touching any selection logic here.
    pub const fn css_var(self) -> &'static str {
        match self {
            Self::Sand => "var(--avatar-sand)",
            Self::Blue => "var(--avatar-blue)",
            Self::Green => "var(--avatar-green)",
            Self::Red => "var(--avatar-red)",
            Self::Violet => "var(--avatar-violet)",
            Self::Orange => "var(--avatar-orange)",
            Self::Pink => "var(--avatar-pink)",
            Self::Emerald => "var(--avatar-emerald)",
            Self::Yellow => "var(--avatar-yellow)",
            Self::Cyan => "var(--avatar-cyan)",
        }
    }

    /// Stable palette selection for an identity seed, normally a Matrix user
    /// ID. SHA-256 keeps the mapping stable across releases and machines and
    /// keeps it independent of the seed's length or shape.
    pub fn for_seed(seed: &str) -> Self {
        let digest = Sha256::digest(seed.as_bytes());
        let mut bucket = [0_u8; 8];
        bucket.copy_from_slice(&digest[..8]);
        let index = (u64::from_be_bytes(bucket) % AVATAR_PALETTE.len() as u64) as usize;
        AVATAR_PALETTE[index]
    }
}

/// Wire value for an identity seed. This is what every backend DTO producer
/// should call; it can never return a colour outside the curated palette.
pub fn avatar_palette_value(seed: &str) -> String {
    AvatarPalette::for_seed(seed).css_var().to_owned()
}

/// Wire value used when there is no seed at all.
pub fn default_avatar_palette_value() -> String {
    DEFAULT_AVATAR_PALETTE.css_var().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn selection_is_always_inside_the_curated_palette() {
        let allowed = AVATAR_PALETTE
            .iter()
            .map(|entry| entry.css_var())
            .collect::<HashSet<_>>();
        for index in 0..5_000 {
            let value = avatar_palette_value(&format!("@user{index}:example.org"));
            assert!(
                allowed.contains(value.as_str()),
                "avatar value {value} escaped the curated palette"
            );
            assert!(
                !value.contains('#'),
                "avatar value {value} still carries a raw colour"
            );
        }
    }

    #[test]
    fn selection_is_stable_for_a_seed() {
        let first = avatar_palette_value("@ada:example.org");
        let second = avatar_palette_value("@ada:example.org");
        assert_eq!(first, second);
        assert_ne!(first, avatar_palette_value("@grace:example.org"));
    }

    #[test]
    fn selection_uses_every_token() {
        let mut seen = HashSet::new();
        for index in 0..2_000 {
            seen.insert(AvatarPalette::for_seed(&format!(
                "@user{index}:example.org"
            )));
        }
        assert_eq!(
            seen.len(),
            AVATAR_PALETTE.len(),
            "some curated avatar tokens are unreachable"
        );
    }

    #[test]
    fn every_token_maps_to_its_custom_property() {
        for entry in AVATAR_PALETTE {
            assert_eq!(entry.css_var(), format!("var(--avatar-{})", entry.token()));
        }
    }
}
