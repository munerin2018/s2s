//! Length-prefixed JSON framing.
//!
//! The JavaScript peers use `it-length-prefixed`, which writes an unsigned
//! LEB128 varint length followed by that many bytes. This is the other end of
//! exactly that format - get it wrong and the two implementations simply never
//! understand each other.

use anyhow::{Result, bail};
use futures::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use serde::{Serialize, de::DeserializeOwned};

pub const MAX_MESSAGE_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_BLOB_BYTES: usize = 16 * 1024 * 1024;

fn write_varint(mut value: usize, out: &mut Vec<u8>) {
    loop {
        let mut byte = (value & 0x7f) as u8;
        value >>= 7;
        if value != 0 {
            byte |= 0x80;
        }
        out.push(byte);
        if value == 0 {
            return;
        }
    }
}

async fn read_varint<S: AsyncRead + Unpin>(stream: &mut S) -> Result<usize> {
    let mut value: usize = 0;
    let mut shift = 0;
    loop {
        let mut byte = [0u8; 1];
        stream.read_exact(&mut byte).await?;
        value |= ((byte[0] & 0x7f) as usize) << shift;
        if byte[0] & 0x80 == 0 {
            return Ok(value);
        }
        shift += 7;
        if shift > 35 {
            bail!("length prefix is implausibly long");
        }
    }
}

pub async fn write_frame<S: AsyncWrite + Unpin>(stream: &mut S, payload: &[u8]) -> Result<()> {
    let mut buf = Vec::with_capacity(payload.len() + 5);
    write_varint(payload.len(), &mut buf);
    buf.extend_from_slice(payload);
    stream.write_all(&buf).await?;
    stream.flush().await?;
    Ok(())
}

pub async fn read_frame<S: AsyncRead + Unpin>(stream: &mut S, max: usize) -> Result<Vec<u8>> {
    let len = read_varint(stream).await?;
    if len > max {
        bail!("frame of {len} bytes exceeds the {max} byte limit");
    }
    let mut buf = vec![0u8; len];
    stream.read_exact(&mut buf).await?;
    Ok(buf)
}

pub async fn write_json<S: AsyncWrite + Unpin, T: Serialize>(stream: &mut S, value: &T) -> Result<()> {
    write_frame(stream, &serde_json::to_vec(value)?).await
}

pub async fn read_json<S: AsyncRead + Unpin, T: DeserializeOwned>(stream: &mut S) -> Result<T> {
    let bytes = read_frame(stream, MAX_MESSAGE_BYTES).await?;
    Ok(serde_json::from_slice(&bytes)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::io::Cursor;

    #[test]
    fn varints_round_trip() {
        for value in [0usize, 1, 127, 128, 300, 16_384, 1_000_000] {
            let mut buf = Vec::new();
            write_varint(value, &mut buf);
            let mut cursor = Cursor::new(buf);
            let got = futures::executor::block_on(read_varint(&mut cursor)).unwrap();
            assert_eq!(got, value);
        }
    }

    #[test]
    fn varint_encoding_matches_the_unsigned_leb128_the_js_side_writes() {
        let mut buf = Vec::new();
        write_varint(300, &mut buf);
        assert_eq!(buf, vec![0xac, 0x02]);
    }
}
