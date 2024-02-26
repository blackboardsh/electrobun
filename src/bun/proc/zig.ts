import {join} from 'path'
import {type RPCSchema, type RPCTransport, createRPC} from 'rpc-anywhere'
import {execSync} from 'child_process';
import * as fs from 'fs';
import electrobunEventEmitter from '../events/eventEmitter';

// console.log('----> meta.url', import.meta.url)
// console.log('----> meta.dir.', import.meta.dir)
// console.log('----> meta.dir', import.meta.resolveSync("electrobun"))
// console.log('----> meta.url.pathname', new URL('../', import.meta.url).pathname)
// console.log('----> __dirname', __dirname)
// // console.log('----> require', require('electrobun'))
// console.log('----> process.cwd', process.cwd())

// const webviewPath = join(new URL('../', import.meta.url).pathname, '../zig/zig-out/bin/webview')
const webviewBinaryPath = join(import.meta.dir, 'native', 'webview');
// const DYLD_LIBRARY_PATH = 'src/zig/build/';

console.log(webviewBinaryPath)

// todo (yoav): make sure process exits when this process exits
// especially on error
const zigProc = Bun.spawn([webviewBinaryPath], {
	stdin: 'pipe',
	stdout: 'pipe',
	//  cwd: webviewPath,
	env: {
		...process.env,
		// Note: Tell the os which folders the zig process is allowed to look for 
		// dynamic libraries in.
		// DYLD_LIBRARY_PATH
	}
});

process.on("beforeExit", (code) => {
	// todo (yoav): maybe send a friendly signal to the webviews to let them know
	// we're shutting down
	
	// clean up the webview process when the bun process dies.
	zigProc.kill();
  });

const mainPipe = `/private/tmp/electrobun_ipc_pipe_${'my-app-id'}_main`;

try {
	execSync('mkfifo ' + mainPipe);
	} catch (e) {
		console.log('pipe out already exists')
	}
	const inStream = fs.createWriteStream(mainPipe, {
		flags: 'w', 		
	});

function createStdioTransport(proc): RPCTransport {
	// let proc: any | null = null;

	return {
	  send(message) {		
		try {										
		const messageString = JSON.stringify(message) + "\n";
		console.log('bun: sending event string', messageString)
		inStream.write(messageString);
		// inStream.flush();
		// proc.stdin.write(messageString);
		// proc.stdin.flush();
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

  // todo (yoav): move this stuff to bun/rpc/zig.ts
type BunSchema = RPCSchema<{
	requests: {
		createWindow: {
			args: {
				id: number,
				url: string | null,
				html: string | null,
				title: string,
				frame: {
					width: number,
					height: number,
					x: number,
					y: number,							
				}
			},
			returns: void
		},
		createWebview: {
			args: {
				id: number,
				url: string | null,
				html: string | null,
				frame: {
					x: number,
					y: number,
					width: number,
					height: number,
				}
			},
			returns: void
		},

		setContentView: {
			args: {
				windowId: number,
				webviewId: number
			},
			returns: void
		}

		loadURL: {
			args: {
				webviewId: number,
				url: string
			},
			returns: void
		}
		loadHTML: {
			args: {
				webviewId: number,
				html: string
			},
			returns: void
		}
		
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
				webviewId: number,
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
		decideNavigation: ({webviewId, url}) => {
			console.log('decide navigation request handler', webviewId, url)

			const willNavigate = electrobunEventEmitter.events.webview.willNavigate({url, webviewId});

			let result;
			// global will-navigate event
			result = electrobunEventEmitter.emitEvent(willNavigate);
			
			result = electrobunEventEmitter.emitEvent(willNavigate, webviewId);			

			if (willNavigate.responseWasSet) {
				return willNavigate.response;
			} else {
				return {allow: true}
			}
			
		},
	},
	maxRequestTime: 25000,
})

export {
    zigRPC,
    zigProc,	
}
