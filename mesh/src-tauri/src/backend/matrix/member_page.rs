const DEFAULT_MEMBER_PAGE_LIMIT: usize = 100;
const MAX_MEMBER_PAGE_LIMIT: usize = 100;
const MAX_MEMBER_CURSOR_BYTES: usize = 512;

fn normalized_member_page_limit(limit: Option<u32>) -> usize {
    limit
        .unwrap_or(DEFAULT_MEMBER_PAGE_LIMIT as u32)
        .clamp(1, MAX_MEMBER_PAGE_LIMIT as u32) as usize
}

fn normalize_member_page_cursor(cursor: Option<String>) -> BackendResult<Option<String>> {
    let Some(cursor) = cursor else {
        return Ok(None);
    };
    if cursor.is_empty()
        || cursor.len() > MAX_MEMBER_CURSOR_BYTES
        || cursor.chars().any(char::is_control)
    {
        return Err(BackendError::InvalidConfiguration(
            "The member-page cursor is invalid. Refresh the member list and try again.".into(),
        ));
    }
    Ok(Some(cursor))
}

/// Select the next stable page while retaining at most `limit + 1` values.
///
/// Matrix 1.16 and matrix-sdk 0.18 expose room membership state as a complete
/// collection rather than a server cursor. Keep Mesh's projection and IPC
/// allocation bounded even when the SDK store already contains a large room.
fn bounded_member_page<T>(
    values: impl IntoIterator<Item = T>,
    cursor: Option<&str>,
    limit: usize,
    key: impl Fn(&T) -> String,
) -> (Vec<T>, Option<String>) {
    let mut retained = BTreeMap::new();
    for value in values {
        let value_key = key(&value);
        if cursor.is_some_and(|cursor| value_key.as_str() <= cursor) {
            continue;
        }
        retained.insert(value_key, value);
        if retained.len() > limit.saturating_add(1) {
            retained.pop_last();
        }
    }

    let has_more = retained.len() > limit;
    if has_more {
        retained.pop_last();
    }
    let next_cursor = has_more
        .then(|| retained.last_key_value().map(|(key, _)| key.clone()))
        .flatten();
    (retained.into_values().collect(), next_cursor)
}

#[cfg(test)]
mod member_page_tests {
    use super::*;

    #[test]
    fn member_page_limits_are_bounded_and_never_zero() {
        assert_eq!(normalized_member_page_limit(None), 100);
        assert_eq!(normalized_member_page_limit(Some(0)), 1);
        assert_eq!(normalized_member_page_limit(Some(40)), 40);
        assert_eq!(normalized_member_page_limit(Some(10_000)), 100);
    }

    #[test]
    fn member_page_cursor_rejects_empty_oversized_and_control_text() {
        assert!(normalize_member_page_cursor(None).is_ok());
        assert!(normalize_member_page_cursor(Some("@a:mesh.test".into())).is_ok());
        assert!(normalize_member_page_cursor(Some(String::new())).is_err());
        assert!(normalize_member_page_cursor(Some("x".repeat(513))).is_err());
        assert!(normalize_member_page_cursor(Some("@a:\nmesh.test".into())).is_err());
    }

    #[test]
    fn member_pages_are_stable_non_overlapping_and_bounded() {
        let values = (0..10_000).rev().collect::<Vec<_>>();
        let (first, first_cursor) = bounded_member_page(values.clone(), None, 100, |value| {
            format!("{value:05}")
        });
        assert_eq!(first, (0..100).collect::<Vec<_>>());
        assert_eq!(first_cursor.as_deref(), Some("00099"));

        let (second, second_cursor) = bounded_member_page(
            values,
            first_cursor.as_deref(),
            100,
            |value| format!("{value:05}"),
        );
        assert_eq!(second, (100..200).collect::<Vec<_>>());
        assert_eq!(second_cursor.as_deref(), Some("00199"));
    }

    #[test]
    fn final_member_page_has_no_cursor() {
        let (page, cursor) = bounded_member_page([3, 1, 2], Some("1"), 10, |value| {
            value.to_string()
        });
        assert_eq!(page, vec![2, 3]);
        assert_eq!(cursor, None);
    }
}
