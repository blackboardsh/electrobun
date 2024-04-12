import electobunEventEmmitter from "./events/eventEmitter";
import { BrowserWindow } from "./core/BrowserWindow";
import { BrowserView } from "./core/BrowserView";
import { Updater } from "./core/Updater";
import {type RPCSchema, createRPC} from 'rpc-anywhere'

// Named Exports
export {
	type RPCSchema,
	createRPC,
	BrowserWindow,
	BrowserView,
	Updater,
};

// Default Export
const Electrobun = {
	BrowserWindow,
	BrowserView,
	Updater,
	events: electobunEventEmmitter
}

// Electrobun
export default Electrobun