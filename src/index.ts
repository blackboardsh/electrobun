import {join} from 'path'

const webviewPath = join(new URL('../', import.meta.url).pathname, 'libs/zig/zig-out/bin/webview')

console.log(webviewPath)

// todo (yoav): make sure process exits when this process exits
// especially on error
const proc = Bun.spawn([webviewPath], {
	stdin: 'pipe',
	stdout: 'pipe',
	//  cwd: webviewPath,
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
const setTitle = (title: string) => {
	const event = {
		type: WebviewEvent.setTitle,
		payload: {
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

type UrlWindowConfig = CreateWindowBaseConfig & {url: string}
type HtmlWindowConfig = CreateWindowBaseConfig & {html: string}

type CreateWindowEvent = {
	type: WebviewEvent.createWindow,
	payload: {id: number} & (UrlWindowConfig | HtmlWindowConfig)
}

const createUrlWindow = (url: string, config: CreateWindowBaseConfig) => {
	return createWindow({
		url,
		html: '',
		...config
	})
}

const createHtmlWindow = (html: string, config: CreateWindowBaseConfig) => {
	return createWindow({
		html,
		url:  '',
		...config
	})
}

let nextWindowId = 0;

const createWindow = (config: UrlWindowConfig | HtmlWindowConfig) => {
	const event: CreateWindowEvent = {
		type: WebviewEvent.createWindow,
		payload: {
			id: nextWindowId++,
			...config
		}
	}

	sendEvent(event);
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
	

	createUrlWindow('https://eggbun.sh', {
		title: 'my url window',
		width: 800,
		height: 600,
		x: 100,
		y: 100,
	})

	// setTimeout(() => {
	setTitle('hello from bun via json - 2')
// }, 0)

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




