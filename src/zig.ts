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
		// Note: Tell the os which folders the zig process is allowed to look for 
		// dynamic libraries in.
		DYLD_LIBRARY_PATH: '../libs/zig/macos/objc/'
	}
});



function createStdioTransport(proc): RPCTransport {
	// let proc: any | null = null;

	return {
	  send(message) {		
		try {										
		const messageString = JSON.stringify(message) + "\n";
		console.log('bun: sending event string', messageString)
		proc.stdin.write(messageString);
		proc.stdin.flush();
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
	
		readStream(proc.stdout);
	
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

const zigRPC = createRPC<BunSchema, ZigSchema>({
	transport: createStdioTransport(zigProc),
	requestHandler: {
		decideNavigation: (args) => {
			console.log('decide navigation request handler', args)
			// todo (yoav): note: typescript should complain here if the return type doesn't
			// match the schema

			// this needs to get the right window/webview and run the decision handler on it
			// if it exists.
			return {allow: true}//args.url.includes('google.com')}
		},
	},
	maxRequestTime: 5000,
})

export {
    zigRPC,
    zigProc
}
