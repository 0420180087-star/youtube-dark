
// =============================================================================
// LOCAL OBFUSCATION SERVICE
// =============================================================================
//
// IMPORTANT — SECURITY LIMITATIONS (read before using):
//
// This module uses AES-GCM (Web Crypto API) to obfuscate values stored in
// localStorage. It is NOT true security. The encryption key is generated once
// and stored in the SAME localStorage as the encrypted values. Any script that
// can read localStorage (XSS attack, malicious browser extension) can trivially
// obtain both the key and the ciphertext.
//
// What this DOES provide:
//   - Obfuscation against casual inspection (DevTools, shoulder surfing)
//   - A small barrier against naive localStorage scraping tools
//
// What this does NOT provide:
//   - Protection against XSS or malicious extensions
//   - Meaningful security for truly sensitive values (e.g. OAuth tokens)
//
// For OAuth tokens specifically: they are kept in React state (AuthContext)
// and only persisted to localStorage as a convenience cache. The real source
// of truth for long-lived tokens is the Supabase `project_auth` table, which
// is accessed exclusively from server-side Edge Functions with the service key.
// =============================================================================

const KEY_STORAGE_NAME = 'ds_master_key_v1';

const bufferToBase64 = (buffer: ArrayBuffer): string => {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
};

const base64ToBuffer = (base64: string): ArrayBuffer => {
    const binary_string = window.atob(base64);
    const len = binary_string.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary_string.charCodeAt(i);
    }
    return bytes.buffer;
};

const getMasterKey = async (): Promise<CryptoKey> => {
    const storedKey = localStorage.getItem(KEY_STORAGE_NAME);
    
    if (storedKey) {
        const keyBuffer = base64ToBuffer(storedKey);
        return await window.crypto.subtle.importKey(
            "raw",
            keyBuffer,
            { name: "AES-GCM", length: 256 },
            true,
            ["encrypt", "decrypt"]
        );
    } else {
        const key = await window.crypto.subtle.generateKey(
            { name: "AES-GCM", length: 256 },
            true,
            ["encrypt", "decrypt"]
        );
        
        const exported = await window.crypto.subtle.exportKey("raw", key);
        localStorage.setItem(KEY_STORAGE_NAME, bufferToBase64(exported));
        return key;
    }
};

export const encryptData = async (data: string): Promise<string> => {
    try {
        if (!data) return '';
        const key = await getMasterKey();
        const iv = window.crypto.getRandomValues(new Uint8Array(12));
        const encodedData = new TextEncoder().encode(data);

        const encryptedBuffer = await window.crypto.subtle.encrypt(
            { name: "AES-GCM", iv: iv },
            key,
            encodedData
        );

        const payload = JSON.stringify({
            iv: bufferToBase64(iv.buffer),
            data: bufferToBase64(encryptedBuffer)
        });

        return bufferToBase64(new TextEncoder().encode(payload).buffer);
    } catch (e) {
        console.error("Encryption failed:", e);
        throw e;
    }
};

export const decryptData = async (encryptedData: string): Promise<string> => {
    try {
        if (!encryptedData) return '';
        
        const cleanData = encryptedData.trim();

        if (cleanData.startsWith('AIza')) {
            return cleanData;
        }

        try {
            const decodedString = new TextDecoder().decode(base64ToBuffer(cleanData));
            
            if (!decodedString.startsWith('{')) {
                return cleanData;
            }

            const payload = JSON.parse(decodedString);
            
            if (!payload.iv || !payload.data) {
                return cleanData;
            }

            const key = await getMasterKey();
            const iv = base64ToBuffer(payload.iv);
            const dataBuffer = base64ToBuffer(payload.data);

            const decryptedBuffer = await window.crypto.subtle.decrypt(
                { name: "AES-GCM", iv: new Uint8Array(iv) },
                key,
                dataBuffer
            );

            return new TextDecoder().decode(decryptedBuffer);
        } catch (innerError) {
            return cleanData;
        }
    } catch (e) {
        console.error("Decryption failed:", e);
        return encryptedData;
    }
};
