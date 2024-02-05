import {BrowserWindow} from '../src'


const win = new BrowserWindow({
    title: 'my url window',
    url: 'https://google.com',
    frame: {
		width: 1800,
		height: 600,
		x: 1000,
		y: 500,
    }
});


win.setTitle('New title from bun')