import Electrobun, { Electroview } from "electrobun/view";

type ControlsRPC = {
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

const rpc = Electroview.defineRPC<ControlsRPC>({
	maxRequestTime: 10000,
	handlers: {
		requests: {},
		messages: {},
	},
});

const electrobun = new Electrobun.Electroview({ rpc });

const dropRate = document.getElementById("dropRate") as HTMLInputElement;
const dropRateValue = document.getElementById("dropRateValue") as HTMLElement;
const cubeSize = document.getElementById("cubeSize") as HTMLInputElement;
const cubeSizeValue = document.getElementById("cubeSizeValue") as HTMLElement;

function updateDropRate() {
	const ms = Number(dropRate.value);
	dropRateValue.textContent = `${ms}ms`;
	electrobun.rpc?.send?.setDropRate({ ms });
}

function updateCubeSize() {
	const size = Number(cubeSize.value);
	cubeSizeValue.textContent = size.toFixed(2);
	electrobun.rpc?.send?.setCubeSize({ size });
}

dropRate.addEventListener("input", updateDropRate);
cubeSize.addEventListener("input", updateCubeSize);

updateDropRate();
updateCubeSize();
