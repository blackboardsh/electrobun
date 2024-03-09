import {join, resolve} from 'path'
import {type RPCSchema, type RPCTransport, createRPC} from 'rpc-anywhere'
import {execSync} from 'child_process';
import * as fs from 'fs';
import electrobunEventEmitter from '../events/eventEmitter';

// todo (yoav): webviewBinaryPath and ELECTROBUN_VIEWS_FOLDER should be passed in as cli/env args by the launcher binary
// will likely be different on different platforms. Right now these are hardcoded for relative paths inside the mac app bundle.
const webviewBinaryPath = join('native', 'webview');

const zigProc = Bun.spawn([webviewBinaryPath], {
	stdin: 'pipe',
	stdout: 'pipe',	
	env: {
		...process.env,		
		ELECTROBUN_VIEWS_FOLDER: resolve('../Resources/app/views'),		
	}
});

process.on("beforeExit", (code) => {
	// todo (yoav): maybe send a friendly signal to the webviews to let them know
	// we're shutting down
	
	// clean up the webview process when the bun process dies.
	zigProc.kill();
  });

// todo: this needs to be globally unique across all apps (including different electrobun apps, and different versions and builds of the same app)
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
	return {
	  send(message) {		
		try {										
		const messageString = JSON.stringify(message) + "\n";		
		inStream.write(messageString);		
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
								console.error('zig: ', line)
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
	};
  }

  // todo (yoav): move this stuff to bun/rpc/zig.ts
type ZigHandlers = RPCSchema<{
	requests: {
		createWindow: {
			params: {
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
			response: void
		},
		createWebview: {
			params: {
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
			response: void
		},

		setContentView: {
			params: {
				windowId: number,
				webviewId: number
			},
			response: void
		}

		loadURL: {
			params: {
				webviewId: number,
				url: string
			},
			response: void
		}
		loadHTML: {
			params: {
				webviewId: number,
				html: string
			},
			response: void
		}
		
		setTitle: {
			params: {
				winId: number,
				title: string
			},
			response: void
		}
	
	}
}>

type BunHandlers = RPCSchema<{
	requests: {
		decideNavigation: {
			params: {
				webviewId: number,
				url: string
			},
			response: {
				allow: boolean
			}
		}
	}
}>

const zigRPC = createRPC<BunHandlers, ZigHandlers>({
	transport: createStdioTransport(zigProc),
	requestHandler: {
		decideNavigation: ({webviewId, url}) => {			
			const willNavigate = electrobunEventEmitter.events.webview.willNavigate({url, webviewId});

			let result;
			// global will-navigate event
			result = electrobunEventEmitter.emitEvent(willNavigate);
			
			result = electrobunEventEmitter.emitEvent(willNavigate, webviewId);			

			if (willNavigate.responseWasSet) {
				return willNavigate.response || {allow: true};
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
