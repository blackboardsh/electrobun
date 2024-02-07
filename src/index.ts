import {join} from 'path'

import {type RPCSchema, type RPCTransport, createRPC} from 'rpc-anywhere'

const webviewPath = join(new URL('../', import.meta.url).pathname, 'libs/zig/zig-out/bin/webview')

console.log(webviewPath)

// todo (yoav): make sure process exits when this process exits
// especially on error
const zigProc = Bun.spawn([webviewPath], {
	stdin: 'pipe',
	stdout: 'pipe',
	//  cwd: webviewPath,
	env: {
		...process.env,
		DYLD_LIBRARY_PATH: '../libs/objc/'
	}
});


// todo (yoav): handle the zigProcess crashing, do we want to auto-restart it and how do we want to manage existing listeners
function createStdioTransport(process): RPCTransport {
	// let proc: any | null = null;

	return {
	  send(message) {		
		try {										
		const messageString = JSON.stringify(message) + "\n";
		console.log('bun: sending event string', messageString)
		zigProc.stdin.write(messageString);
		zigProc.stdin.flush();
		} catch (error) {
			console.error('bun: failed to serialize message to zig', error)
		}
		
	  },
	  registerHandler(handler) {

		async function readStream(stream) {
			const reader = stream.getReader();
			let buffer = '';
		
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					buffer += new TextDecoder().decode(value);
					let eolIndex;
					console.log("bun: received chunk", buffer)
					// Process each line contained in the buffer
					while ((eolIndex = buffer.indexOf('\n')) >= 0) {
						const line = buffer.slice(0, eolIndex).trim();
						buffer = buffer.slice(eolIndex + 1);
						if (line) {
							try {
								const event = JSON.parse(line);
								handler(event)										
							} catch (error) {
								// Non-json things are just bubbled up to the console.
								console.log('zig: ', line)
							}                    
						}
					}
				}
			} catch (error) {
				console.error("Error reading from stream:", error);
			} finally {
				reader.releaseLock();
			}
		}
	
		readStream(zigProc.stdout);
	
	  },
	//   unregisterHandler() {
	// 	// if (listener) channel.removeMessageListener(listener);
	//   },
	};
  }

type BunSchema = RPCSchema<{
	requests: {
		createWindow: {
			args: {
				url: string | null,
				html: string | null,
				title: string,
				width: number,
				height: number,
				x: number,
				y: number,				
			
			},
			returns: void
		},
		setTitle: {
			args: {
				winId: number,
				title: string
			},
			returns: void
		}
	
	}
}>

type ZigSchema = RPCSchema<{
	requests: {
		decideNavigation: {
			args: {
				url: string
			},
			returns: {
				allow: boolean
			}
		}
	}

}>

// const handleZigEvent = (event: any) => {
// 	console.log('hanldeX')


// 	// switch (event.type) {
// 	// 	case xPromiseMessageType.decideNavigation: {
// 	// 		const {url} = event.payload as {url: string};
// 	// 		console.log('bun: decideNavigation event received', url)

// 	// 		// todo (yoav): encapsulate this, send response back to zig
// 	// 		sendEvent({
// 	// 			id: event.id,
// 	// 			type: xPromiseMessageType.decideNavigation,
// 	// 			phase: xPromiseMessagePhase.response,
// 	// 			payload: {					
// 	// 				allow: url.includes('google.com'),					
// 	// 			}
// 	// 		})
// 	// 	}
// 	// }
// }



const zigRPC = createRPC<BunSchema, ZigSchema>({
	transport: createStdioTransport(zigProc),
	requestHandler: {
		decideNavigation: (args) => {
			console.log('decide navigation request handler', args)
			// todo (yoav): note: typescript should complain here if the return type doesn't
			// match the schema
			return {allow: args.url.includes('google.com')}
		},
	},
	maxRequestTime: 5000,
})



enum xPromiseMessageType {
	setTitle = "setTitle",
	createWindow = "createWindow",
	decideNavigation = "decideNavigation",
}

enum xPromiseMessagePhase {
	request = "request",
	response = "response",
}





// Read from stdout


const xPromise = {
	createWindow: {
		request: (config: {url: string, html: string, title: string, width: number, height: number, x: number, y: number}) => {
			const event = {
				type: xPromiseMessageType.createWindow,
				phase: xPromiseMessagePhase.request,
				payload: config
			}	
		
			sendEvent(event)
		}
	},
	
	setTitle: {
		request: (winId: number, title: string) => {
			const event = {
				type: xPromiseMessageType.setTitle,
				phase: xPromiseMessagePhase.request,
				payload: {
					winId,
					title
				}
			}	
		
			sendEvent(event)
		}
	},

}

type CreateWindowBaseConfig = {	
	title: string,
	width: number,
	height: number,
	x: number,
	y: number,
}

type UrlWindowConfig = CreateWindowBaseConfig & {url: string, html: null}
type HtmlWindowConfig = CreateWindowBaseConfig & {html: string, url: null}

type CreateWindowEvent = {
	type: xPromiseMessageType.createWindow,
	phase: xPromiseMessagePhase.request,
	payload: {id: number} & (UrlWindowConfig | HtmlWindowConfig)
}

const createUrlWindow = (url: string, config: CreateWindowBaseConfig) => {
	return createWindow({
		url,
		html: null,
		...config
	})
}

const createHtmlWindow = (html: string, config: CreateWindowBaseConfig) => {
	return createWindow({
		html,
		url: null,
		...config
	})
}

let nextWindowId = 0;

const createWindow = (config: UrlWindowConfig | HtmlWindowConfig) => {
	// todo (yoav): implement win status and lifecycle that updates
	// from objc events sent from zig

	// todo (yoav): also wrap in class with methods like setTitle, etc
	const win = {
		id: nextWindowId++,
		...config
	}

	const event: CreateWindowEvent = {
		type: xPromiseMessageType.createWindow,
		phase: xPromiseMessagePhase.request,
		payload: win
	}

	sendEvent(event);

	return win;
}

// Note: the zig side has an equivalent id generator that cycles between a different min/max range
let next_id_min = 100;
let next_id_max = 200;
let next_id = next_id_min;
const nextId = (() => {	
	next_id = Math.max(next_id_min, (next_id + 1) % next_id_max)
	return (next_id)
});

const sendEvent = (event: any) => {
	event.id = event.id || nextId()

	console.log('sending event', event)
	// const withStringifiedPayload = event.payload = JSON.stringify(event.payload)
	const eventString = JSON.stringify(event) + "\n";
	console.log('bun: sending event string', eventString)
	zigProc.stdin.write(eventString);
	zigProc.stdin.flush();
}


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
		const win = {
			id: this.id,
			title: this.title,
			url: this.url,
			html: this.html,
			width: this.frame.width,
			height: this.frame.height,
			x: this.frame.x,
			y: this.frame.y,
		}

		// xPromise.createWindow.request({
		// 	id: this.id,
		// 		title: this.title,
		// 		url: this.url,
		// 		html: this.html,
				
		// 		width: this.frame.width,
		// 		height: this.frame.height,
		// 		x: this.frame.x,
		// 		y: this.frame.y,
		// });

		zigRPC.request.createWindow(win)
		

		// sendEvent(event).then(() => {
		// 	this.state = 'created'
		// })
	  }

	  setTitle(title: string) {
		this.title = title;
		return zigRPC.request.setTitle({winId: this.id, title})//xPromise.setTitle.request(this.id, title)
	  }
	
	  
	  loadURL(url) {
		
	  }
	
	  loadHTML(html) {
		
	  }
	
	  
	
}


// zigProc.stdin.write("hello\n");
// zigProc.stdin.flush();

// zigProc.stdin.end();

const Electrobun = {
	BrowserWindow,
}


// Electrobun
export default Electrobun