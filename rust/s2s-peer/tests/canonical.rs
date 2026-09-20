//! Conformance against the shared vectors in `docs/canonical-vectors.json`.
//!
//! The JavaScript peers run the same file. This is what stops the two
//! implementations drifting apart in a way that only shows up much later, as
//! signatures that mysteriously fail to verify across the boundary.

use std::path::PathBuf;

use serde_json::Value;

/// The crate's canonical encoder, reached through the binary's module tree.
#[path = "../src/codec.rs"]
mod codec;

fn vectors() -> Value {
    let path: PathBuf = [env!("CARGO_MANIFEST_DIR"), "..", "..", "docs", "canonical-vectors.json"]
        .iter()
        .collect();
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("could not read {}: {e}", path.display()));
    serde_json::from_str(&text).expect("the vector file is valid JSON")
}

#[test]
fn every_valid_vector_encodes_to_exactly_the_documented_bytes() {
    let v = vectors();
    let cases = v["valid"].as_array().expect("valid is a list");
    assert!(cases.len() >= 15, "the vector set should not shrink silently");

    for case in cases {
        let why = case["why"].as_str().unwrap_or("");
        let expected = case["canonical"].as_str().expect("canonical is a string");
        let got = codec::canonical(&case["input"])
            .unwrap_or_else(|e| panic!("{why}: expected an encoding, got error {e}"));
        assert_eq!(got, expected, "{why}");
    }
}

#[test]
fn every_rejected_vector_is_refused_rather_than_guessed_at() {
    let v = vectors();
    for case in v["rejected"].as_array().expect("rejected is a list") {
        let why = case["why"].as_str().unwrap_or("");
        let raw = case["json"].as_str().expect("json is a string");
        let parsed: Value = serde_json::from_str(raw).expect("the vector itself parses");
        assert!(
            codec::canonical(&parsed).is_err(),
            "{why}: {raw} should have been refused"
        );
    }
}
