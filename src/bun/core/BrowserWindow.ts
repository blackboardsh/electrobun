import { zigRPC } from '../proc/zig'
import * as fs from 'fs';
import {execSync} from 'child_process';
import electrobunEventEmitter from '../events/eventEmitter';

// Note: start at 1, so that 0 can be used in the zig renderer's rpc udata
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
	webview: {
		on: (event: 'will-navigate', handler: (url: string) => boolean) => void
	} = {
		on: (event: 'will-navigate', handler: (url: string) => boolean) => {
			// todo (yoav): this should be a real event emitter
			console.log('webview on', event, handler)
		}
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
			console.log('pipe out already exists')
		}

		try {
			execSync('mkfifo ' + webviewPipeIn);
			} catch (e) {
				console.log('pipe in already exists')
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
	
		// inStream.on('data', (chunk) => {
		//     console.log(`Received on named pipe <><>><><><><>: ${chunk.toString()}`);
		// });	
		
		// inStream.on('error', (err) => {
		//     console.error('Error:', err);
		// });
		
		// inStream.write('hello from bun through named pipe\n');
		// inStream.end();


		zigRPC.request.createWindow(win)

		const inStream = fs.createWriteStream(webviewPipeIn, {
			flags: 'w', 		
		});
	
		inStream.write('\n');

		setTimeout(() => {
			inStream.write('document.body.innerHTML = "wow yeah!";\n');
		}, 5000)
	


	
		
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

	  // todo (yoav): move this to a class that also has off, append, prepend, etc.
	  // todo (yoav): also make a webview one that handles will-navigate
	  on(name, handler) {
		const specificName = `${name}-${this.id}`;
		electrobunEventEmitter.on(specificName, handler);
	  }

	  
}

