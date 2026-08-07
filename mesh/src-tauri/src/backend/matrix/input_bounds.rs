const COMMUNITY_NAME_MAX_UTF16: usize = 100;
const COMMUNITY_DESCRIPTION_MAX_UTF16: usize = 500;
const CHANNEL_NAME_MAX_UTF16: usize = 100;

fn metadata_utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn forbidden_metadata_character(character: char, multiline: bool) -> bool {
    let allowed_layout = multiline && matches!(character, '\n' | '\r' | '\t');
    (!allowed_layout && character.is_control())
        || matches!(
            character,
            '\u{061c}'
                | '\u{200e}'
                | '\u{200f}'
                | '\u{202a}'..='\u{202e}'
                | '\u{2066}'..='\u{2069}'
        )
}

fn normalize_required_metadata(
    value: String,
    label: &str,
    max_utf16: usize,
) -> BackendResult<String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(BackendError::InvalidConfiguration(format!("{label} is required.")));
    }
    if metadata_utf16_len(value) > max_utf16 {
        return Err(BackendError::InvalidConfiguration(format!(
            "{label} must be {max_utf16} characters or fewer."
        )));
    }
    if value
        .chars()
        .any(|character| forbidden_metadata_character(character, false))
    {
        return Err(BackendError::InvalidConfiguration(format!(
            "{label} contains unsupported formatting characters."
        )));
    }
    Ok(value.to_owned())
}

fn normalize_optional_metadata(
    value: String,
    label: &str,
    max_utf16: usize,
) -> BackendResult<String> {
    let value = value.trim();
    if metadata_utf16_len(value) > max_utf16 {
        return Err(BackendError::InvalidConfiguration(format!(
            "{label} must be {max_utf16} characters or fewer."
        )));
    }
    if value
        .chars()
        .any(|character| forbidden_metadata_character(character, true))
    {
        return Err(BackendError::InvalidConfiguration(format!(
            "{label} contains unsupported formatting characters."
        )));
    }
    Ok(value.to_owned())
}

fn bounded_remote_member_display_name(value: &str, fallback_user_id: &str) -> String {
    fn append_bounded(target: &mut String, source: &str) {
        let mut used = 0;
        for character in source.trim().chars() {
            if forbidden_metadata_character(character, false) {
                continue;
            }
            let width = character.len_utf16();
            if used + width > COMMUNITY_NAME_MAX_UTF16 {
                break;
            }
            target.push(character);
            used += width;
        }
    }

    let mut bounded = String::new();
    append_bounded(&mut bounded, value);
    if bounded.is_empty() {
        append_bounded(&mut bounded, fallback_user_id);
    }
    if bounded.is_empty() {
        "Community member".into()
    } else {
        bounded
    }
}

fn bounded_remote_application_reason(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    let mut bounded = String::new();
    let mut used = 0;
    let mut pending_space = false;
    for character in value.chars() {
        if character.is_whitespace() {
            pending_space = !bounded.is_empty();
            continue;
        }
        if forbidden_metadata_character(character, false) {
            continue;
        }
        let width = character.len_utf16();
        let required = width + usize::from(pending_space);
        if used + required > COMMUNITY_DESCRIPTION_MAX_UTF16 {
            break;
        }
        if pending_space {
            bounded.push(' ');
            used += 1;
            pending_space = false;
        }
        bounded.push(character);
        used += width;
    }
    (!bounded.is_empty()).then_some(bounded)
}

#[cfg(test)]
mod input_bounds_tests {
    use super::*;

    #[test]
    fn metadata_limits_match_renderer_utf16_semantics() {
        assert_eq!(
            normalize_required_metadata(
                "x".repeat(COMMUNITY_NAME_MAX_UTF16),
                "Community name",
                COMMUNITY_NAME_MAX_UTF16,
            )
            .expect("the exact community-name limit should pass")
            .len(),
            COMMUNITY_NAME_MAX_UTF16
        );
        assert!(normalize_required_metadata(
            "x".repeat(COMMUNITY_NAME_MAX_UTF16 + 1),
            "Community name",
            COMMUNITY_NAME_MAX_UTF16,
        )
        .is_err());

        let astral = "😀".repeat(COMMUNITY_NAME_MAX_UTF16 / 2);
        assert_eq!(metadata_utf16_len(&astral), COMMUNITY_NAME_MAX_UTF16);
        assert!(normalize_required_metadata(
            format!("{astral}😀"),
            "Community name",
            COMMUNITY_NAME_MAX_UTF16,
        )
        .is_err());
    }

    #[test]
    fn metadata_rejects_empty_names_controls_and_bidi_overrides() {
        assert!(normalize_required_metadata(
            "   ".into(),
            "Room name",
            CHANNEL_NAME_MAX_UTF16,
        )
        .is_err());
        assert!(normalize_required_metadata(
            "safe\nunsafe".into(),
            "Room name",
            CHANNEL_NAME_MAX_UTF16,
        )
        .is_err());
        assert!(normalize_required_metadata(
            "safe\u{202e}unsafe".into(),
            "Room name",
            CHANNEL_NAME_MAX_UTF16,
        )
        .is_err());
    }

    #[test]
    fn descriptions_are_optional_multiline_and_bounded() {
        assert_eq!(
            normalize_optional_metadata(
                "  line one\nline two  ".into(),
                "Description",
                COMMUNITY_DESCRIPTION_MAX_UTF16,
            )
            .expect("plain multiline descriptions should pass"),
            "line one\nline two"
        );
        assert!(normalize_optional_metadata(
            "x".repeat(COMMUNITY_DESCRIPTION_MAX_UTF16 + 1),
            "Description",
            COMMUNITY_DESCRIPTION_MAX_UTF16,
        )
        .is_err());
        assert!(normalize_optional_metadata(
            "safe\u{0007}unsafe".into(),
            "Description",
            COMMUNITY_DESCRIPTION_MAX_UTF16,
        )
        .is_err());
    }

    #[test]
    fn remote_member_names_are_sanitized_and_bounded_before_ipc() {
        assert_eq!(
            bounded_remote_member_display_name("\u{202e}\n", "@alice:mesh.test"),
            "@alice:mesh.test"
        );
        assert_eq!(
            metadata_utf16_len(&bounded_remote_member_display_name(
                &"😀".repeat(100),
                "@alice:mesh.test",
            )),
            COMMUNITY_NAME_MAX_UTF16
        );
    }

    #[test]
    fn remote_application_reasons_are_plain_and_bounded_before_ipc() {
        let reason = format!("  hello\n\u{202e}{}  ", "x".repeat(600));
        let bounded = bounded_remote_application_reason(Some(&reason)).unwrap();
        assert!(bounded.starts_with("hello "));
        assert!(!bounded.contains('\n'));
        assert!(!bounded.contains('\u{202e}'));
        assert_eq!(metadata_utf16_len(&bounded), COMMUNITY_DESCRIPTION_MAX_UTF16);
        assert!(bounded_remote_application_reason(Some(" \n ")).is_none());
        assert!(bounded_remote_application_reason(None).is_none());
    }
}
