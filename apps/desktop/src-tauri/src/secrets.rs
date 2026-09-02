#[tauri::command]
pub fn secrets_set(service: String, account: String, secret: String) -> Result<(), String> {
    validate(&service, &account)?;
    imp::set(&target(&service, &account), &secret)
}

#[tauri::command]
pub fn secrets_get(service: String, account: String) -> Result<Option<String>, String> {
    validate(&service, &account)?;
    imp::get(&target(&service, &account))
}

#[tauri::command]
pub fn secrets_delete(service: String, account: String) -> Result<(), String> {
    validate(&service, &account)?;
    imp::delete(&target(&service, &account))
}

fn target(service: &str, account: &str) -> String {
    format!("{service}/{account}")
}

fn validate(service: &str, account: &str) -> Result<(), String> {
    if service != "matrix-agent" {
        return Err("unsupported secret service".into());
    }
    if account.is_empty() || account.len() > 200 || account.contains('\0') {
        return Err("invalid secret account".into());
    }
    Ok(())
}

#[cfg(windows)]
mod imp {
    use std::ffi::OsStr;
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::core::BOOL;
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
        CRED_TYPE_GENERIC,
    };

    fn wide(value: &str) -> Vec<u16> {
        OsStr::new(value).encode_wide().chain(once(0)).collect()
    }

    pub fn set(target: &str, secret: &str) -> Result<(), String> {
        let mut target_w = wide(target);
        let mut blob = secret.as_bytes().to_vec();
        let credential = CREDENTIALW {
            Flags: 0,
            Type: CRED_TYPE_GENERIC,
            TargetName: target_w.as_mut_ptr(),
            Comment: std::ptr::null_mut(),
            LastWritten: FILETIME {
                dwLowDateTime: 0,
                dwHighDateTime: 0,
            },
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            AttributeCount: 0,
            Attributes: std::ptr::null_mut(),
            TargetAlias: std::ptr::null_mut(),
            UserName: std::ptr::null_mut(),
        };
        let ok: BOOL = unsafe { CredWriteW(&credential, 0) };
        if ok == 0 {
            return Err("failed to store password in Windows Credential Manager".into());
        }
        Ok(())
    }

    pub fn get(target: &str) -> Result<Option<String>, String> {
        let target_w = wide(target);
        let mut cred: *mut CREDENTIALW = std::ptr::null_mut();
        let ok: BOOL = unsafe { CredReadW(target_w.as_ptr(), CRED_TYPE_GENERIC, 0, &mut cred) };
        if ok == 0 || cred.is_null() {
            return Ok(None);
        }
        let result = unsafe {
            let blob = std::slice::from_raw_parts(
                (*cred).CredentialBlob,
                (*cred).CredentialBlobSize as usize,
            );
            String::from_utf8(blob.to_vec())
        };
        unsafe { CredFree(cred.cast()) };
        result.map(Some).map_err(|_| "stored password was not UTF-8".into())
    }

    pub fn delete(target: &str) -> Result<(), String> {
        let target_w = wide(target);
        let ok: BOOL = unsafe { CredDeleteW(target_w.as_ptr(), CRED_TYPE_GENERIC, 0) };
        if ok == 0 {
            return Ok(());
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn set(_target: &str, _secret: &str) -> Result<(), String> {
        Err("OS keychain storage is not available on this platform yet".into())
    }

    pub fn get(_target: &str) -> Result<Option<String>, String> {
        Ok(None)
    }

    pub fn delete(_target: &str) -> Result<(), String> {
        Ok(())
    }
}
