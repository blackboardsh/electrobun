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

const setTitle = (title: string) => {
	const event = {
		type: WebviewEvent.setTitle,
		payload: JSON.stringify({title})
	}	

	sendEvent(event)
}

const sendEvent = (event: any) => {
	const eventString = JSON.stringify(event) + "\n";
	console.log('sending event', eventString)
	proc.stdin.write(eventString);
	proc.stdin.flush();
}

setTimeout(() => {
	setTitle('hello from bun via json')
	
}, 2000)

proc.stdin.write("hello\n");
proc.stdin.flush();

// proc.stdin.end();




