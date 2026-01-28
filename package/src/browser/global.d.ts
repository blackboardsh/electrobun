// Global type declarations for Electrobun browser environment

interface ElectrobunEncryptResult {
  encryptedData: string;
  iv: string;
  tag: string;
}

interface ElectrobunBridge {
  receiveMessageFromBun: (msg: unknown) => void;
  receiveInternalMessageFromBun: (msg: unknown) => void;
}

interface MessageHandler {
  postMessage: (msg: string) => void;
}

declare global {
  interface Window {
    __electrobunWebviewId: number;
    __electrobunWindowId: number;
    __electrobunRpcSocketPort: number;
    __electrobun?: ElectrobunBridge;
    __electrobun_encrypt: (msg: string) => Promise<ElectrobunEncryptResult>;
    __electrobun_decrypt: (encryptedData: string, iv: string, tag: string) => Promise<string>;
    __electrobunInternalBridge?: MessageHandler;
    __electrobunBunBridge?: MessageHandler;
  }
}

export {};
