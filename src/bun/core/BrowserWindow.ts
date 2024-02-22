import { zigRPC } from '../proc/zig'
import * as fs from 'fs';
import {execSync} from 'child_process';
import electrobunEventEmitter from '../events/eventEmitter';
import { BrowserView } from './BrowserView';

let nextWindowId = 1;

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
	preloadScript?: string
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
	
		
		this.init();
	  }
	
	  init() {	
		
		

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
			frame: this.frame
		});

		this.webviewId = webview.id;

		zigRPC.request.setContentView({
			windowId: this.id,
			webviewId: webview.id
		});

		if (this.url) {
			this.loadURL(this.url);
		} else if (this.html) {
			this.loadHTML(this.html);			
		}

		BrowserWindowMap[this.id] = this;			
	  }

	  setTitle(title: string) {
		this.title = title;
		return zigRPC.request.setTitle({winId: this.id, title})
	  }
	
	  
	  loadURL(url: string) {
		this.url = url;
		zigRPC.request.loadURL({webviewId: this.id, url: this.url})
	  }
	
	  loadHTML(html: string) {
		this.html = html;
		zigRPC.request.loadHTML({webviewId: this.id, html: this.html})
	  }

	  // todo (yoav): move this to a class that also has off, append, prepend, etc.
	  // todo (yoav): also make a webview one that handles will-navigate
	  on(name, handler) {
		const specificName = `${name}-${this.id}`;
		electrobunEventEmitter.on(specificName, handler);
	  }

	  
}

