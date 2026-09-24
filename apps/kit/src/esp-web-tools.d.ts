// Web Serial (`navigator.serial`, `SerialPort`), which esp-web-tools' `flash` writes through. The
// shared tsconfig lists its `types`, so this one is referenced here.
/// <reference types="w3c-web-serial" />

// Chrome's Credential Management API, which TypeScript's DOM lib leaves out: Kit hands the Wi-Fi to
// the browser's password manager (routes/_auth/devices.$deviceId.firmware.$firmwareVersion.tsx).
declare class PasswordCredential extends Credential {
  constructor(data: { id: string; password: string; name?: string });
}
