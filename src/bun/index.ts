import electobunEventEmmitter from "./events/eventEmitter";
import { BrowserWindow } from "./core/BrowserWindow";
import {type RPCSchema, createRPC} from 'rpc-anywhere'

// Named Exports
export {
	type RPCSchema,
	createRPC,
	BrowserWindow,
};

// Default Export
const Electrobun = {
	BrowserWindow,
	events: electobunEventEmmitter
}

// Electrobun
export default Electrobun