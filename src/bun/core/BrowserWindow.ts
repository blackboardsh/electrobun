import { zigRPC } from '../proc/zig'
import * as fs from 'fs';
import {execSync} from 'child_process';
import electrobunEventEmitter from '../events/eventEmitter';
import { BrowserView } from './BrowserView';
import {type RPC} from 'rpc-anywhere'

let nextWindowId = 1;

// todo (yoav): if we default to builtInSchema, we don't want dev to have to define custom handlers
// for the built-in schema stuff.
type WindowOptionsType = {
	title: string,
	frame: {
		x: number,
		y: number,
		width: number,
		height: number,
	},
	url: string | null,
	html: string | null,
	preloadScript?: string,
	rpc?: RPC<any, any>
}

const defaultOptions: WindowOptionsType = {
	title: 'Electrobun',
	frame: {
		x: 0,
		y: 0,
		width: 800,
		height: 600,
	},
	url: 'https://electrobun.dev',
	html: null,	
}

const BrowserWindowMap = {};



// todo (yoav): do something where the type extends the default schema
// that way we can provide built-in requests/messages and devs can extend it

export class BrowserWindow {
	id: number = nextWindowId++;
	title: string = 'Electrobun';
	state: 'creating' | 'created' = 'creating'
	url: string | null = null;
	html: string | null = null;
	frame: {
		x: number,
		y: number,
		width: number,
		height: number,
	} = {
		x: 0,
		y: 0,
		width: 800,
		height: 600,
	}
	// todo (yoav): make this an array of ids or something
	webviewId: number



	constructor(options: Partial<WindowOptionsType> = defaultOptions) {
		this.title = options.title || 'New Window';
		this.frame = options.frame ? {...defaultOptions.frame, ...options.frame} : {...defaultOptions.frame};
		this.url = options.url || null;
		this.html = options.html || null;			
	
		
		this.init(options.rpc);
	  }
	
	  init(rpc?: RPC<any, any>) {	
		
		

		zigRPC.request.createWindow({
			id: this.id,
			title: this.title,
			url: this.url,
			html: this.html,
            frame: {
                width: this.frame.width,
                height: this.frame.height,
                x: this.frame.x,
                y: this.frame.y,
            }
		});

		// todo (yoav): user should be able to override this and pass in their
		// own webview instance, or instances for attaching to the window.
		const webview = new BrowserView({
			url: this.url, 
			html: this.html, 
			frame: this.frame,
			rpc
		});

		this.webviewId = webview.id;

		zigRPC.request.setContentView({
			windowId: this.id,
			webviewId: webview.id
		});

		if (this.url) {
			webview.loadURL(this.url);
		} else if (this.html) {
			webview.loadHTML(this.html);			
		}

		BrowserWindowMap[this.id] = this;			
	  }

	  get webview() {
		return BrowserView.getById(this.webviewId);
	  }

	  setTitle(title: string) {
		this.title = title;
		return zigRPC.request.setTitle({winId: this.id, title})
	  }
	
	  
	  

	  // todo (yoav): move this to a class that also has off, append, prepend, etc.
	  // name should only allow browserWindow events
	  on(name, handler) {
		const specificName = `${name}-${this.id}`;
		electrobunEventEmitter.on(specificName, handler);
	  }

	  
}

