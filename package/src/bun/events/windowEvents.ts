import ElectrobunEvent from "./event";

type IdData = { id: number };
type ResizeData = {
	id: number;
	x: number;
	y: number;
	width: number;
	height: number;
};
type MoveData = { id: number; x: number; y: number };
type KeyData = { id: number; keyCode: number; modifiers: number; isRepeat: boolean };

export default {
	close: (data: IdData) => new ElectrobunEvent<IdData, {}>("close", data),
	resize: (data: ResizeData) =>
		new ElectrobunEvent<ResizeData, {}>("resize", data),
	move: (data: MoveData) => new ElectrobunEvent<MoveData, {}>("move", data),
	focus: (data: IdData) => new ElectrobunEvent<IdData, {}>("focus", data),
	keyDown: (data: KeyData) => new ElectrobunEvent<KeyData, {}>("keyDown", data),
	keyUp: (data: KeyData) => new ElectrobunEvent<KeyData, {}>("keyUp", data),
};
