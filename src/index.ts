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

enum WebviewEvent {
	setTitle = 0,
	createWindow = 1,
}

async function readStream(stream) {
	const reader = stream.getReader();
	try {
	  while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		const output = new TextDecoder().decode(value);
		// Process the output
		console.log("Received output:", output);
	  }
	} catch (error) {
	  console.error("Error reading from stream:", error);
	} finally {
	  reader.releaseLock();
	}
  }
  
// Read from stdout
readStream(proc.stdout);


// Send messages to zig
const setTitle = (winId: number, title: string) => {
	const event = {
		type: WebviewEvent.setTitle,
		payload: {
			winId,
			title
		}
	}	

	sendEvent(event)
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
	type: WebviewEvent.createWindow,
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
		url:  null,
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
		type: WebviewEvent.createWindow,
		payload: win
	}

	sendEvent(event);

	return win;
}



const sendEvent = (event: any) => {
	const eventString = JSON.stringify(event) + "\n";
	console.log('sending event', eventString)
	proc.stdin.write(eventString);
	proc.stdin.flush();
}


// tst
setTimeout(() => {
	// setTitle('hello from bun via json')
	const win = createUrlWindow('https://google.com', {
		title: 'my url window',
		width: 1800,
		height: 600,
		x: 1000,
		y: 500,
	})

	// const win2 = createHtmlWindow('<html><head></head><body><h1>hello</h1></body></html>', {
	// 	title: 'my html window',
	// 	width: 1000,
	// 	height: 900,
	// 	x: 500,
	// 	y: 900,
	// });

	
	setTitle(win.id, 'hello from bun via json -  win one')
	// setTitle(win2.id, 'hello from bun via json -  win two')


	// createHtmlWindow('<html><head></head><body><h1>hello</h1></body></html>', {
	// 	title: 'my html window',
	// 	width: 800,
	// 	height: 600,
	// 	x: 100,
	// 	y: 100,
	// })

	
}, 2000)

proc.stdin.write("hello\n");
proc.stdin.flush();

// proc.stdin.end();




