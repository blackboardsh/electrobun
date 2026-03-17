import type { RPCSchema } from "electrobun/view";

export type BunnyRPC = {
	bun: RPCSchema<{
		requests: {};
		messages: {
			bunnyClicked: void;
		};
	}>;
	webview: RPCSchema<{
		requests: {};
		messages: {
			cursorMove: {
				screenX: number;
				screenY: number;
				winX: number;
				winY: number;
				winW: number;
				winH: number;
			};
		};
	}>;
};
