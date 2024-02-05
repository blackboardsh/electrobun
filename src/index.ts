import {join} from 'path'

const webviewPath = join(new URL('../', import.meta.url).pathname, 'libs/zig/zig-out/bin/webview')

console.log(webviewPath)

// todo (yoav): make sure process exits when this process exits
// especially on error
const proc = Bun.spawn([webviewPath], {
	stdin: 'pipe',
	stdout: 'pipe',
	//  cwd: webviewPath,
	env: {
		...process.env,
		DYLD_LIBRARY_PATH: '../libs/objc/'
	}
});

enum xPromiseMessageType {
	setTitle = "setTitle",
	createWindow = "createWindow",
	decideNavigation = "decideNavigation",
}

enum xPromiseMessagePhase {
	request = "request",
	response = "response",
}

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
						handleZigEvent(event)										
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

const handleZigEvent = (event: any) => {
	switch (event.type) {
		case xPromiseMessageType.decideNavigation: {
			const {url} = event.payload as {url: string};
			console.log('bun: decideNavigation event received', url)

			// todo (yoav): encapsulate this, send response back to zig
			sendEvent({
				id: event.id,
				type: xPromiseMessageType.decideNavigation,
				phase: xPromiseMessagePhase.response,
				payload: {					
					allow: url.includes('google.com'),					
				}
			})
		}
	}
}

// Read from stdout
readStream(proc.stdout);

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
	proc.stdin.write(eventString);
	proc.stdin.flush();
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

		xPromise.createWindow.request({
			id: this.id,
				title: this.title,
				url: this.url,
				html: this.html,
				
				width: this.frame.width,
				height: this.frame.height,
				x: this.frame.x,
				y: this.frame.y,
		});
		// sendEvent(event).then(() => {
		// 	this.state = 'created'
		// })
	  }

	  setTitle(title: string) {
		this.title = title;
		return xPromise.setTitle.request(this.id, title)
	  }
	
	  
	  loadURL(url) {
		
	  }
	
	  loadHTML(html) {
		
	  }
	
	  
	
}


// tst
// setTimeout(() => {
// 	// setTitle('hello from bun via json')
// 	const win = createUrlWindow('https://google.com', {
// 		title: 'my url window',
// 		width: 1800,
// 		height: 600,
// 		x: 1000,
// 		y: 500,
// 	})

// 	const win2 = createHtmlWindow('<html><head></head><body style="background: #000;"><h1>hello</h1></body></html>', {
// 		title: 'my html window',
// 		width: 1000,
// 		height: 900,
// 		x: 500,
// 		y: 900,
// 	});

	
// 	xPromise.setTitle.request(win.id, 'hello from bun via json -  win one')
// 	xPromise.setTitle.request(win2.id, 'hello from bun via json -  win two')


// 	// createHtmlWindow('<html><head></head><body><h1>hello</h1></body></html>', {
// 	// 	title: 'my html window',
// 	// 	width: 800,
// 	// 	height: 600,
// 	// 	x: 100,
// 	// 	y: 100,
// 	// })

	
// }, 2000)

// proc.stdin.write("hello\n");
// proc.stdin.flush();

// proc.stdin.end();

const Electrobun = {
	BrowserWindow,
}


// Electrobun
export default Electrobun