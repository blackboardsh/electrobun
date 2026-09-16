// Controlled single-line text input built from the core primitives: a
// focusable box containing [before-caret text][caret][after-caret text].
// Editing runs through the pure applyEditKey reducer; the caret blinks only
// while focused, so idle inputs stay invalidation-free.

import { cleanup, inert, live, liveScope, signal } from "./reactive";
import { getUiContext, read, ui, type KeyEventInfo, type Reactive } from "./ui";
import { applyEditKey, normalizeEditKeyCode } from "./keymap";

export interface TextInputProps {
	value: () => string;
	onInput: (next: string) => void;
	/** Enter. */
	onSubmit?: (value: string) => void;
	placeholder?: string;
	autofocus?: boolean;
	size?: number;
	grow?: Reactive<number>;
	width?: Reactive<number>;
	pad?: Reactive<number>;
	radius?: Reactive<number>;
	bg?: Reactive<string | number>;
	color?: string;
	placeholderColor?: string;
	caretColor?: string;
	border?: Reactive<number>;
	borderColor?: Reactive<string | number>;
	focusBorderColor?: Reactive<string | number>;
}

export function textInput(props: TextInputProps): number {
	const ctx = getUiContext();
	const size = props.size ?? 14;
	const color = props.color ?? "#e4e4f0";
	const placeholderColor = props.placeholderColor ?? "#616178";
	const caretColor = props.caretColor ?? "#e4e4f0";

	const [caret, setCaret] = signal(inert(props.value).length);
	const [blinkOn, setBlinkOn] = signal(true);

	let id = 0;
	const focused = () => ctx.focusedId() === id;

	const handleKey = (e: KeyEventInfo): boolean => {
		const value = inert(props.value);
		// applyEditKey clamps the caret itself; String.slice clamps in render.
		const result = applyEditKey(
			{ value, caret: inert(caret) },
			normalizeEditKeyCode(e.keyCode, process.platform),
			e.modifiers,
			e.chars,
		);
		if (!result.handled) return false;
		if (result.submit) {
			props.onSubmit?.(value);
			return true;
		}
		setCaret(result.caret);
		setBlinkOn(true);
		if (result.value !== value) props.onInput(result.value);
		return true;
	};
	const handleText = (text: string): boolean => {
		const value = inert(props.value);
		const result = applyEditKey(
			{ value, caret: inert(caret) },
			0,
			0,
			text,
		);
		if (!result.handled) return false;
		setCaret(result.caret);
		setBlinkOn(true);
		if (result.value !== value) props.onInput(result.value);
		return true;
	};

	id = ui.row(
		{
			focusable: true,
			onKeyDown: handleKey,
			onTextInput: handleText,
			onClick: () => setCaret(inert(props.value).length),
			grow: props.grow,
			width: props.width,
			pad: props.pad ?? 10,
			radius: props.radius ?? 8,
			align: "center",
			bg: props.bg ?? "#1b1b28",
			border: props.border ?? 1,
			borderColor: live(() =>
				focused() && props.focusBorderColor !== undefined
					? read(props.focusBorderColor)
					: read(props.borderColor ?? "#262638"),
			),
		},
		() => {
			// Placeholder: an empty text node has zero width, so this only
			// occupies space while the value is empty.
			ui.text(
				live(() =>
					props.value().length === 0 ? props.placeholder ?? "" : "",
				),
				{ size, color: placeholderColor },
			);
			ui.text(live(() => props.value().slice(0, caret())), {
				size,
				color,
			});
			ui.box({
				width: Math.max(1.5, size / 9),
				height: size + 2,
				bg: live(() =>
					focused() && blinkOn() ? caretColor : "#00000000",
				),
			});
			ui.text(live(() => props.value().slice(caret())), { size, color });
		},
	);

	// Blink only while focused; an idle unfocused input never dirties the tree.
	liveScope(() => {
		if (!focused()) {
			setBlinkOn(true);
			return;
		}
		const timer = setInterval(() => setBlinkOn((v) => !v), 530);
		cleanup(() => clearInterval(timer));
	});

	if (props.autofocus) {
		ctx.setFocused(id);
	}

	return id;
}
