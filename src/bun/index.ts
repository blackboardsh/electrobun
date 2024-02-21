import electobunEventEmmitter from "./events/eventEmitter";
import { BrowserWindow } from "./core/BrowserWindow";

// Named Exports
export {BrowserWindow};

// Default Export
const Electrobun = {
	BrowserWindow,
	events: electobunEventEmmitter
}

// Electrobun
export default Electrobun