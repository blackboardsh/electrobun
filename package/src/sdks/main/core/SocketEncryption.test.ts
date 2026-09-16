import { describe, expect, test } from "bun:test";
import { encryptHostTransportPacket } from "./hostTransportEncryption";

describe("Linux host transport encryption", () => {
	test("produces the AES-256-GCM envelope consumed by WebCrypto", async () => {
		const secretKey = Uint8Array.from(
			{ length: 32 },
			(_, index) => index,
		);
		const messageJson = JSON.stringify({
			type: "response",
			id: 42,
			success: true,
			payload: "hello from Bun 🥕 你好",
		});
		const packet = encryptHostTransportPacket(messageJson, secretKey);

		expect(Object.keys(packet)).toEqual(["encryptedData", "iv", "tag"]);
		const iv = new Uint8Array(Buffer.from(packet.iv, "base64"));
		const encryptedData = new Uint8Array(
			Buffer.from(packet.encryptedData, "base64"),
		);
		const tag = new Uint8Array(Buffer.from(packet.tag, "base64"));
		expect(iv).toHaveLength(12);
		expect(tag).toHaveLength(16);

		const ciphertext = new Uint8Array(encryptedData.length + tag.length);
		ciphertext.set(encryptedData);
		ciphertext.set(tag, encryptedData.length);
		const webCryptoKey = await crypto.subtle.importKey(
			"raw",
			secretKey,
			{ name: "AES-GCM" },
			false,
			["decrypt"],
		);
		const decrypted = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv },
			webCryptoKey,
			ciphertext,
		);

		expect(new TextDecoder().decode(decrypted)).toBe(messageJson);
	});
});
