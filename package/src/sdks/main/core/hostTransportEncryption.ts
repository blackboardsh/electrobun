import { createCipheriv, randomBytes } from "crypto";

export type EncryptedHostTransportPacket = {
	encryptedData: string;
	iv: string;
	tag: string;
};

export const encryptHostTransportPacket = (
	messageJson: string,
	secretKey: Uint8Array,
): EncryptedHostTransportPacket => {
	const iv = randomBytes(12);
	const cipher = createCipheriv(
		"aes-256-gcm",
		new Uint8Array(secretKey),
		new Uint8Array(iv),
	);
	const encryptedData =
		cipher.update(messageJson, "utf8", "base64") + cipher.final("base64");

	return {
		encryptedData,
		iv: iv.toString("base64"),
		tag: cipher.getAuthTag().toString("base64"),
	};
};
