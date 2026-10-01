//! Job secrets (API tokens) encrypted with Windows DPAPI for the current user.
//! Only this Windows account on this machine can decrypt them; they are stored
//! as base64 in jobs.json and decrypted just before a run, into the agent's
//! environment. Never logged.

use base64::Engine as _;

#[cfg(windows)]
mod dpapi {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB};

    fn take(blob: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        let out = unsafe { std::slice::from_raw_parts(blob.pbData, blob.cbData as usize).to_vec() };
        unsafe {
            let _ = LocalFree(Some(HLOCAL(blob.pbData as _)));
        }
        out
    }

    pub fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
        let input = CRYPT_INTEGER_BLOB { cbData: plain.len() as u32, pbData: plain.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB::default();
        unsafe { CryptProtectData(&input, None, None, None, None, 0, &mut out) }.map_err(|e| format!("encrypt: {e}"))?;
        Ok(take(out))
    }

    pub fn unprotect(cipher: &[u8]) -> Result<Vec<u8>, String> {
        let input = CRYPT_INTEGER_BLOB { cbData: cipher.len() as u32, pbData: cipher.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB::default();
        unsafe { CryptUnprotectData(&input, None, None, None, None, 0, &mut out) }.map_err(|e| format!("decrypt: {e}"))?;
        Ok(take(out))
    }
}

pub fn seal(value: &str) -> Result<String, String> {
    #[cfg(windows)]
    let bytes = dpapi::protect(value.as_bytes())?;
    #[cfg(not(windows))]
    let bytes = value.as_bytes().to_vec(); // other platforms: not implemented yet (Windows-only app)
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

pub fn open(sealed: &str) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(sealed).map_err(|e| format!("bad secret: {e}"))?;
    #[cfg(windows)]
    let bytes = dpapi::unprotect(&bytes)?;
    String::from_utf8(bytes).map_err(|_| "secret is not valid text".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_ciphertext_hides_the_value() {
        let s = seal("cf-token-123").unwrap();
        assert!(!s.contains("cf-token"));
        let raw = base64::engine::general_purpose::STANDARD.decode(&s).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("cf-token-123"));
        assert_eq!(open(&s).unwrap(), "cf-token-123");
        assert!(open("not base64!").is_err());
    }
}
