//! Canonical encoding, identifiers and signature checking.
//!
//! Every byte produced here has to match what the JavaScript peers produce,
//! because both sides hash and sign the same bytes. The rule is the same one
//! `packages/core/src/codec.js` implements: object keys sorted, no whitespace,
//! no absent members.
//!
//! Numbers are where the two most easily drift. `JSON.parse("1.0")` yields the
//! integer 1 in JavaScript with no trace of the text it came from, so both
//! sides normalise an integral value to the same digits and refuse anything
//! that cannot be represented identically - a real fraction, or a magnitude
//! past `Number.MAX_SAFE_INTEGER`.

use anyhow::{Context, Result, bail};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fmt::Write;

/// `Number.MAX_SAFE_INTEGER`: beyond this the two languages round differently.
const MAX_SAFE_INTEGER: i64 = (1i64 << 53) - 1;
const MAX_SAFE_INTEGER_F: f64 = 9_007_199_254_740_991.0;

/// Deterministic JSON. Arrays keep their order; object keys are sorted.
pub fn canonical(value: &Value) -> Result<String> {
    let mut out = String::new();
    write_canonical(value, &mut out)?;
    Ok(out)
}

fn write_canonical(value: &Value, out: &mut String) -> Result<()> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            // Mirrors the JavaScript rule: safe integers only, written without
            // a fractional part.
            //
            // A float that happens to be integral is normalised rather than
            // refused, because `JSON.parse("1.0")` on the other side yields
            // the integer 1 and there is no way for it to know the text said
            // "1.0". Refusing here while JavaScript accepts would let a
            // crafted event be stored by half the network and rejected by the
            // other half, which splits that author's log permanently.
            let i = match n.as_i64() {
                Some(i) => i,
                None => match n.as_f64() {
                    Some(f) if f.is_finite() && f.fract() == 0.0 && f.abs() <= MAX_SAFE_INTEGER_F => {
                        f as i64
                    }
                    _ => bail!("canonical: numbers must be safe integers, got {n}"),
                },
            };
            if !(-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&i) {
                bail!("canonical: integer out of safe range: {i}");
            }
            let _ = write!(out, "{i}");
        }
        Value::String(s) => write_json_string(s, out),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(item, out)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            // `str` compares by UTF-8 bytes, which is code point order. The
            // JavaScript side sorts by code point explicitly for this reason:
            // its default sort compares UTF-16 code units, which puts astral
            // characters in a different place.
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_unstable();
            out.push('{');
            for (i, key) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json_string(key, out);
                out.push(':');
                write_canonical(&map[key], out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

/// Matches `JSON.stringify` for strings: escape only what must be escaped and
/// leave every other code point as literal UTF-8.
fn write_json_string(s: &str, out: &mut String) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    let digest = Sha256::digest(bytes);
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

pub fn b58(bytes: &[u8]) -> String {
    bs58::encode(bytes).into_string()
}

pub fn unb58(s: &str) -> Result<Vec<u8>> {
    bs58::decode(s).into_vec().context("invalid base58")
}

pub fn author_id(public_key: &[u8]) -> String {
    format!("@{}", b58(public_key))
}

pub fn event_id(bytes: &[u8]) -> String {
    format!("%{}", b58(&sha256(bytes)))
}

pub fn blob_id(bytes: &[u8]) -> String {
    format!("&{}", b58(&sha256(bytes)))
}

/// Decode an identifier to its 32 bytes, refusing anything else.
///
/// Identifiers arrive from the network, so they are claims rather than names.
/// Slicing one by byte offset without checking is how `&日本` becomes a panic
/// and `&../identity.json` becomes a file read.
pub fn decode_id(id: &str, prefix: char) -> Result<[u8; 32]> {
    let rest = id
        .strip_prefix(prefix)
        .with_context(|| format!("id does not start with {prefix}"))?;
    let raw = unb58(rest)?;
    if raw.len() != 32 {
        bail!("id is not 32 bytes");
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&raw);
    Ok(out)
}

pub fn is_author_id(id: &str) -> bool {
    decode_id(id, '@').is_ok()
}

pub fn is_event_id(id: &str) -> bool {
    decode_id(id, '%').is_ok()
}

pub fn is_blob_id(id: &str) -> bool {
    decode_id(id, '&').is_ok()
}

/// Verify an ed25519 signature made by `author` over `message`.
pub fn verify_signature(author: &str, message: &[u8], signature_b58: &str) -> Result<()> {
    let key_bytes = decode_id(author, '@')?;
    let key = VerifyingKey::from_bytes(&key_bytes).context("author is not a valid public key")?;

    let sig_raw = unb58(signature_b58)?;
    if sig_raw.len() != 64 {
        bail!("signature is not 64 bytes");
    }
    let mut sig_bytes = [0u8; 64];
    sig_bytes.copy_from_slice(&sig_raw);

    key.verify(message, &Signature::from_bytes(&sig_bytes))
        .context("signature does not verify")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn c(v: &Value) -> String {
        canonical(v).unwrap()
    }

    #[test]
    fn canonical_sorts_keys_and_drops_whitespace() {
        assert_eq!(c(&json!({"b": 1, "a": 2})), r#"{"a":2,"b":1}"#);
        assert_eq!(c(&json!({"a": [3, 1]})), r#"{"a":[3,1]}"#);
        assert_eq!(c(&json!(null)), "null");
    }

    #[test]
    fn strings_escape_the_same_characters_javascript_does() {
        assert_eq!(c(&json!("a\"b\\c\nd")), r#""a\"b\\c\nd""#);
        // Non-ASCII stays literal, exactly as JSON.stringify leaves it.
        assert_eq!(c(&json!("日本語 🚀")), "\"日本語 🚀\"");
        assert_eq!(c(&json!("\u{1}")), r#""\u0001""#);
    }

    #[test]
    fn keys_sort_by_code_point_not_utf16_code_unit() {
        // U+FFFD is below U+1F680 by code point but above it by UTF-16 code
        // unit. Both implementations must agree on this ordering or their
        // signatures diverge.
        assert_eq!(
            c(&json!({"\u{1F680}": 1, "\u{FFFD}": 2})),
            "{\"\u{FFFD}\":2,\"\u{1F680}\":1}"
        );
    }

    #[test]
    fn numbers_normalise_to_exactly_what_javascript_writes() {
        assert!(canonical(&json!(1.5)).is_err());
        assert!(canonical(&json!(9_007_199_254_740_993_i64)).is_err());
        // An integral float normalises, because JSON.parse("1.0") gives 1 and
        // the other side cannot tell the text apart.
        assert_eq!(c(&json!(1.0)), "1");
        assert_eq!(c(&json!(-0.0)), "0");
        assert_eq!(c(&json!(1)), "1");
        assert_eq!(c(&json!(-7)), "-7");
    }

    #[test]
    fn identifiers_are_checked_rather_than_sliced() {
        // Each of these used to reach a byte-offset slice or a path join.
        for evil in ["&日本", "&", "&../identity.json", "&/etc/passwd", "", "&!!!"] {
            assert!(!is_blob_id(evil), "{evil} must not pass as a blob id");
            assert!(decode_id(evil, '&').is_err());
        }
        assert!(is_blob_id(&blob_id(b"hello")));
    }
}
