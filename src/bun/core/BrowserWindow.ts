import { zigRPC } from '../proc/zig'
import * as fs from 'fs';
import {execSync} from 'child_process';

let nextWindowId = 0;

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

const defaultWindowOptions: WindowOptionsType = {
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

	constructor(options: Partial<WindowOptionsType> = defaultWindowOptions) {
		this.title = options.title || 'New Window';
		this.frame = options.frame ? options.frame : defaultWindowOptions.frame;
		this.url = options.url || null;
		this.html = options.html || null;			
	
		
		this.init();
	  }
	
	  init() {
		// is this.id available here?
		
		


		

		// todo (yoav): wait for window/webview to be created		
		// todo (yoav): track ids for webviews as well
		const webviewPipe = `/private/tmp/electrobun_ipc_pipe_${this.id}_1`;
		const webviewPipeIn = webviewPipe + '_in';
		const webviewPipeOut = webviewPipe + '_out';
		
		try {
		execSync('mkfifo ' + webviewPipeOut);
		} catch (e) {
			console.log('pipe already exists')
		}

		const win = {
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
		}

		zigRPC.request.createWindow(win)

		
		
// Open the named pipe for reading
	
	const outStream = fs.createReadStream(webviewPipeOut, {
		flags: 'r', 		
	});
	
	outStream.on('data', (chunk) => {
	    console.log(`Received on named pipe <><>><><><><>: ${chunk.toString()}`);
	});	
	
	outStream.on('error', (err) => {
	    console.error('Error:', err);
	});

		

		// sendEvent(event).then(() => {
		// 	this.state = 'created'
		// })
	  }

	  setTitle(title: string) {
		this.title = title;
		return zigRPC.request.setTitle({winId: this.id, title})
	  }
	
	  
	  loadURL(url) {
		
	  }
	
	  loadHTML(html) {
		
	  }
	
	  
	
}

