// Global type declarations for Electrobun browser environment

interface ElectrobunEncryptResult {
  encryptedData: string;
  iv: string;
  tag: string;
}

interface ElectrobunBridge {
  receiveMessageFromHost: (msg: unknown) => void;
  receiveInternalMessageFromHost: (msg: unknown) => void;
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
    __electrobunHostSocketPort?: number;
    __electrobunPlaintextHostSocket?: boolean;
    __electrobun?: ElectrobunBridge;
    __electrobunPendingHostMessages?: unknown[];
    __electrobun_encrypt: (msg: string) => Promise<ElectrobunEncryptResult>;
    __electrobun_decrypt: (encryptedData: string, iv: string, tag: string) => Promise<string>;
    __electrobunInternalBridge?: MessageHandler;
    __electrobunHostBridge?: MessageHandler;
    __electrobunBunBridge?: MessageHandler;
  }
}

export {};
