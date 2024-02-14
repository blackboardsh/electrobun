import { zigRPC } from '../proc/zig'

let nextWindowId = 0;

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
	preloadScript?: string
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
            frame: {
                width: this.frame.width,
                height: this.frame.height,
                x: this.frame.x,
                y: this.frame.y,
            }
		}

		zigRPC.request.createWindow(win)
		

		// sendEvent(event).then(() => {
		// 	this.state = 'created'
		// })
	  }

	  setTitle(title: string) {
		this.title = title;
		return zigRPC.request.setTitle({winId: this.id, title})
	  }
	
	  
	  loadURL(url) {
		
	  }
	
	  loadHTML(html) {
		
	  }
	
	  
	
}

