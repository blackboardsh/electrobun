import { zigRPC } from '../proc/zig'
import * as fs from 'fs';
import {execSync} from 'child_process';
import electrobunEventEmitter from '../events/eventEmitter';
import {type RPC} from 'rpc-anywhere'

const BrowserViewMap = {};
let nextWebviewId = 1;

type BrowserViewOptions = {    
    url: string | null;
    html: string | null;
    preload: string | null;
    frame: {
        x: number,
        y: number,
        width: number,
        height: number,
    }
    rpc?: RPC<any, any>
}

const defaultOptions: BrowserViewOptions = {    
    url: 'https://electrobun.dev',
    html: null,
    preload: null,
    frame: {
        x: 0,
        y: 0,
        width: 800,
        height: 600,
    },    
}


export class BrowserView {
    id: number = nextWebviewId++;
    url: string | null = null;
    html: string | null = null;
    preload: string | null = null;
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
    inStream: fs.WriteStream;
    outStream: fs.ReadStream;
    rpc: RPC<any, any> | null;

    constructor(options: Partial<BrowserViewOptions> = defaultOptions) {
        this.url = options.url || defaultOptions.url;
        this.html = options.html || defaultOptions.html;
        this.preload = options.preload || defaultOptions.preload;
        this.frame = options.frame ? {...defaultOptions.frame, ...options.frame} : {...defaultOptions.frame};        
        this.rpc = options.rpc;

        this.init();
    }

    init() {                  
        zigRPC.request.createWebview({
            id: this.id,                
            url: this.url,
            html: this.html,
            preload: this.preload,
            frame: {
                width: this.frame.width,
                height: this.frame.height,
                x: this.frame.x,
                y: this.frame.y,
            }
        })

        this.createStreams();

        BrowserViewMap[this.id] = this;
    }

    createStreams() {
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

        const inStream = fs.createWriteStream(webviewPipeIn, {
            flags: 'w', 		
        });
    
        // todo: something has to be written to it to open it
        // look into this
        inStream.write('\n');

        this.inStream = inStream;

        
    


    
        
// Open the named pipe for reading
    
    const outStream = fs.createReadStream(webviewPipeOut, {
        flags: 'r', 		
    });       

    this.outStream = outStream;

        if (this.rpc) {
            this.rpc.setTransport(this.createTransport());            
        }
    }

    sendMessageToWebview(jsonMessage) {        
        const stringifiedMessage = typeof jsonMessage === 'string' ? jsonMessage : JSON.stringify(jsonMessage);
        // todo (yoav): make this a shared const with the browser api
        const wrappedMessage = `window.__electrobun.receiveMessageFromBun(${stringifiedMessage})`;
        this.executeJavascript(wrappedMessage);
    }

    executeJavascript(js: string) {        
        this.inStream.write(js + '\n');
    }

    loadURL(url: string) {
		this.url = url;
		zigRPC.request.loadURL({webviewId: this.id, url: this.url})
	  }
	
	  loadHTML(html: string) {
		this.html = html;
		zigRPC.request.loadHTML({webviewId: this.id, html: this.html})
	  }

    // todo (yoav): move this to a class that also has off, append, prepend, etc.
	  // name should only allow browserView events
      // Note: normalize event names to willNavigate instead of ['will-navigate'] to save
      // 5 characters per usage and allow minification to be more effective.
	  on(name: 'will-navigate', handler) {
		const specificName = `${name}-${this.id}`;
		electrobunEventEmitter.on(specificName, handler);
	  }

      createTransport = () => {
        const that = this;
        
        return {
            send(message) {
                // todo (yoav): note: this is the same as the zig transport
                try {
                    const messageString = JSON.stringify(message);                    
                    that.sendMessageToWebview(messageString);
                } catch (error) {
                    console.error('bun: failed to serialize message to webview', error)
                }
            },
            registerHandler(handler) {
                let buffer = '';
                // todo (yoav): readStream function is identical to the one in zig.ts
                that.outStream.on('data', (chunk) => {
                    buffer += chunk.toString();                    
                    let eolIndex;

                    while ((eolIndex = buffer.indexOf('\n')) >= 0) {
                        const line = buffer.slice(0, eolIndex).trim();
                        buffer = buffer.slice(eolIndex + 1);                        
                        if (line) {
                            try {
                                const event = JSON.parse(line);
                                handler(event)										
                            } catch (error) {
                                // Non-json things are just bubbled up to the console.
                                console.error('webview: ', line)
                            }                    
                        }
                    }                                       
                });	                              
            }
        }
      }

      static getById(id: number) {
            return BrowserViewMap[id];
      }

      static getAll() {
        return Object(BrowserViewMap).values();
      }
}