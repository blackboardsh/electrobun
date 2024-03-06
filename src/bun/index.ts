import electobunEventEmmitter from "./events/eventEmitter";
import { BrowserWindow } from "./core/BrowserWindow";
import { BrowserView } from "./core/BrowserView";
import {type RPCSchema, createRPC} from 'rpc-anywhere'

// Named Exports
export {
	type RPCSchema,
	createRPC,
	BrowserWindow,
	BrowserView,
};

// Default Export
const Electrobun = {
	BrowserWindow,
	BrowserView,
	events: electobunEventEmmitter
}

// Electrobun
export default Electrobun