import "./index.css";
import { render } from "solid-js/web";
import Electrobun, { Electroview } from "electrobun/view";
import App from "./App";

type HudRPC = {
	bun: {
		requests: {};
		messages: {
			setDropRate: { ms: number };
			setCubeSize: { size: number };
		};
	};
	webview: {
		requests: {};
		messages: {};
	};
};

const rpc = Electroview.defineRPC<HudRPC>({
	maxRequestTime: 10000,
	handlers: {
		requests: {},
		messages: {},
	},
});

const electrobun = new Electrobun.Electroview({ rpc });

// Expose RPC send functions for the Solid app
(window as any).__rpcSend = {
	setDropRate: (ms: number) => electrobun.rpc?.send?.setDropRate({ ms }),
	setCubeSize: (size: number) => electrobun.rpc?.send?.setCubeSize({ size }),
};

render(() => <App />, document.getElementById("app")!);
