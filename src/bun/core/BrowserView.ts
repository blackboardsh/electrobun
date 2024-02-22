import { zigRPC } from '../proc/zig'
import * as fs from 'fs';
import {execSync} from 'child_process';
import electrobunEventEmitter from '../events/eventEmitter';

const BrowserViewMap = {};
let nextWebviewId = 1;

type BrowserViewOptions = {    
    url: string | null;
    html: string | null;
    frame: {
        x: number,
        y: number,
        width: number,
        height: number,
    }
    preloadScript: string | null;
}

const defaultOptions: BrowserViewOptions = {    
    url: 'https://electrobun.dev',
    html: null,
    frame: {
        x: 0,
        y: 0,
        width: 800,
        height: 600,
    },
    preloadScript: null,
}

export class BrowserView {
    id: number = nextWebviewId++;
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
    inStream: fs.WriteStream;
    outStream: fs.ReadStream;

    constructor(options: Partial<BrowserViewOptions> = defaultOptions) {
        this.url = options.url || defaultOptions.url;
        this.html = options.html || defaultOptions.html;
        this.frame = options.frame ? {...defaultOptions.frame, ...options.frame} : {...defaultOptions.frame};

        this.init();
    }

    init() {
        
            // is this.id available here?
            
            
    
            
    
           	
        
            // inStream.on('data', (chunk) => {
            //     console.log(`Received on named pipe <><>><><><><>: ${chunk.toString()}`);
            // });	
            
            // inStream.on('error', (err) => {
            //     console.error('Error:', err);
            // });
            
            // inStream.write('hello from bun through named pipe\n');
            // inStream.end();
    
    
            zigRPC.request.createWebview({
                id: this.id,                
                url: this.url,
                html: this.html,
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
    
    outStream.on('data', (chunk) => {
        // todo (yoav): implemnt a proper reader up to \n
        // when event is read and parsed it should emit an webview onMessage event
        // it should also tie into webview's RPC anywhere types and handlers
        console.log(`Received on named pipe <><>><><><><>: ${chunk.toString()}`);
    });	
    
    outStream.on('error', (err) => {
        console.error('Error:', err);
    });

    this.outStream = outStream;
    }

    sendMessageToWebview(jsonMessage) {
        const stringifiedMessage = JSON.stringify(jsonMessage);
        const wrappedMessage = `electrobun.receiveMessageFromBun(${stringifiedMessage})`;
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

      static getById(id: number) {
            return BrowserViewMap[id];
      }

      static getAll() {
        return Object(BrowserViewMap).values();
      }

}