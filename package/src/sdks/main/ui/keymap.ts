// Keyboard mapping and text-edit reducer. Pure — testable without a window.
//
// Prototype honesty: the native key event carries a virtual key code but no
// character, so this maps macOS virtual key codes assuming a US layout.
// Production work is characters (and IME) in the native key event itself.

export const Mod = {
	Shift: 1 << 0,
	Ctrl: 1 << 1,
	Alt: 1 << 2,
	Cmd: 1 << 3,
} as const;

export const Key = {
	Return: 36,
	Tab: 48,
	Space: 49,
	Backspace: 51,
	Escape: 53,
	Left: 123,
	Right: 124,
	Down: 125,
	Up: 126,
} as const;

// macOS virtual key code → [char, shiftedChar]
const CHARS: Record<number, [string, string]> = {
	0: ["a", "A"], 1: ["s", "S"], 2: ["d", "D"], 3: ["f", "F"],
	4: ["h", "H"], 5: ["g", "G"], 6: ["z", "Z"], 7: ["x", "X"],
	8: ["c", "C"], 9: ["v", "V"], 11: ["b", "B"], 12: ["q", "Q"],
	13: ["w", "W"], 14: ["e", "E"], 15: ["r", "R"], 16: ["y", "Y"],
	17: ["t", "T"], 18: ["1", "!"], 19: ["2", "@"], 20: ["3", "#"],
	21: ["4", "$"], 22: ["6", "^"], 23: ["5", "%"], 24: ["=", "+"],
	25: ["9", "("], 26: ["7", "&"], 27: ["-", "_"], 28: ["8", "*"],
	29: ["0", ")"], 30: ["]", "}"], 31: ["o", "O"], 32: ["u", "U"],
	33: ["[", "{"], 34: ["i", "I"], 35: ["p", "P"], 37: ["l", "L"],
	38: ["j", "J"], 39: ["'", '"'], 40: ["k", "K"], 41: [";", ":"],
	42: ["\\", "|"], 43: [",", "<"], 44: ["/", "?"], 45: ["n", "N"],
	46: ["m", "M"], 47: [".", ">"], 49: [" ", " "], 50: ["`", "~"],
};

/** Printable character for a key event, or null. */
export function charForKey(keyCode: number, modifiers: number): string | null {
	if (modifiers & (Mod.Cmd | Mod.Ctrl)) return null;
	const entry = CHARS[keyCode];
	if (!entry) return null;
	return modifiers & Mod.Shift ? entry[1] : entry[0];
}

export interface EditState {
	value: string;
	caret: number;
}

export interface EditResult extends EditState {
	handled: boolean;
	submit: boolean;
}

/**
 * Apply one key event to a text-edit state. Handles character insertion,
 * backspace (with cmd = clear-to-start, alt = delete word), caret movement
 * (with cmd = home/end, alt = word-wise), and Enter (submit). Unhandled keys
 * (e.g. Up/Down, Escape) pass through so callers can bubble them.
 */
export function applyEditKey(
	state: EditState,
	keyCode: number,
	modifiers: number,
): EditResult {
	const { value } = state;
	const caret = Math.max(0, Math.min(state.caret, value.length));

	if (keyCode === Key.Return) {
		return { value, caret, handled: true, submit: true };
	}

	if (keyCode === Key.Backspace) {
		if (caret === 0) return { value, caret, handled: true, submit: false };
		let from = caret - 1;
		if (modifiers & Mod.Cmd) from = 0;
		else if (modifiers & Mod.Alt) from = wordLeft(value, caret);
		return {
			value: value.slice(0, from) + value.slice(caret),
			caret: from,
			handled: true,
			submit: false,
		};
	}

	if (keyCode === Key.Left) {
		const to =
			modifiers & Mod.Cmd ? 0
			: modifiers & Mod.Alt ? wordLeft(value, caret)
			: Math.max(0, caret - 1);
		return { value, caret: to, handled: true, submit: false };
	}

	if (keyCode === Key.Right) {
		const to =
			modifiers & Mod.Cmd ? value.length
			: modifiers & Mod.Alt ? wordRight(value, caret)
			: Math.min(value.length, caret + 1);
		return { value, caret: to, handled: true, submit: false };
	}

	const char = charForKey(keyCode, modifiers);
	if (char !== null) {
		return {
			value: value.slice(0, caret) + char + value.slice(caret),
			caret: caret + 1,
			handled: true,
			submit: false,
		};
	}

	return { value, caret, handled: false, submit: false };
}

function wordLeft(value: string, from: number): number {
	let i = from;
	while (i > 0 && value[i - 1] === " ") i--;
	while (i > 0 && value[i - 1] !== " ") i--;
	return i;
}

function wordRight(value: string, from: number): number {
	let i = from;
	while (i < value.length && value[i] === " ") i++;
	while (i < value.length && value[i] !== " ") i++;
	return i;
}
