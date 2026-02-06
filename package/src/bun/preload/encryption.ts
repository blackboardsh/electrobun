// Encryption/Decryption for secure RPC
// Uses per-webview secret key set in window.__electrobunSecretKeyBytes

import "./globals.d.ts";

function base64ToUint8Array(base64: string): Uint8Array {
	return new Uint8Array(
		atob(base64)
			.split("")
			.map((char) => char.charCodeAt(0)),
	);
}

function uint8ArrayToBase64(uint8Array: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < uint8Array.length; i++) {
		binary += String.fromCharCode(uint8Array[i]!);
	}
	return btoa(binary);
}

async function generateKeyFromBytes(rawKey: Uint8Array): Promise<CryptoKey> {
	return await window.crypto.subtle.importKey(
		"raw",
		rawKey as unknown as ArrayBuffer,
		{ name: "AES-GCM" },
		true,
		["encrypt", "decrypt"],
	);
}

export async function initEncryption(): Promise<void> {
	const secretKey = await generateKeyFromBytes(
		new Uint8Array(window.__electrobunSecretKeyBytes),
	);

	const encryptString = async (
		plaintext: string,
	): Promise<{ encryptedData: string; iv: string; tag: string }> => {
		const encoder = new TextEncoder();
		const encodedText = encoder.encode(plaintext);
		const iv = window.crypto.getRandomValues(new Uint8Array(12));
		const encryptedBuffer = await window.crypto.subtle.encrypt(
			{ name: "AES-GCM", iv },
			secretKey,
			encodedText,
		);

		// Split the tag (last 16 bytes) from the ciphertext
		const encryptedData = new Uint8Array(encryptedBuffer.slice(0, -16));
		const tag = new Uint8Array(encryptedBuffer.slice(-16));

		return {
			encryptedData: uint8ArrayToBase64(encryptedData),
			iv: uint8ArrayToBase64(iv),
			tag: uint8ArrayToBase64(tag),
		};
	};

	const decryptString = async (
		encryptedDataB64: string,
		ivB64: string,
		tagB64: string,
	): Promise<string> => {
		const encryptedData = base64ToUint8Array(encryptedDataB64);
		const iv = base64ToUint8Array(ivB64);
		const tag = base64ToUint8Array(tagB64);

		// Combine encrypted data and tag to match the format expected by SubtleCrypto
		const combinedData = new Uint8Array(encryptedData.length + tag.length);
		combinedData.set(encryptedData);
		combinedData.set(tag, encryptedData.length);

		const decryptedBuffer = await window.crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: iv as unknown as ArrayBuffer },
			secretKey,
			combinedData as unknown as ArrayBuffer,
		);

		const decoder = new TextDecoder();
		return decoder.decode(decryptedBuffer);
	};

	window.__electrobun_encrypt = encryptString;
	window.__electrobun_decrypt = decryptString;
}
