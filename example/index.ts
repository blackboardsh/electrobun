import {BrowserWindow} from '../src/bun'


// const win = new BrowserWindow({
//     title: 'my url window',
//     url: 'https://google.com',
//     frame: {
// 		width: 1800,
// 		height: 600,
// 		x: 1000,
// 		y: 500,
//     }
// });


// win.setTitle('New title from bun')


const win = new BrowserWindow({
    title: 'my url window',
    html: `
    <html>
        <head></head>
        <body>
            <script>
                window.webkit.messageHandlers.bunBridge.postMessage("Hello from JavaScript!");
                window.electrobun.bunBridge("Hello from bun bridge!");
            </script>
            <h1>hi</h1>
        </body>
    </html>
    `,
    frame: {
		width: 1800,
		height: 600,
		x: 1000,
		y: 500,
    }
});


win.setTitle('New title from bun')