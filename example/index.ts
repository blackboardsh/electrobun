import Electrobun, {BrowserWindow} from '../src/bun'


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


// todo (yoav): typescript types should resolve for e and e.setResponse
Electrobun.events.on('will-navigate', (e) => {
    console.log('example global will navigate handler', e.data.url, e.data.windowId )
    e.setResponse({allow: false});
})

win.on('will-navigate', (e) => {
    console.log('example webview will navigate handler', e.data.url, e.data.windowId )
    e.setResponse({allow: true});
})

win.setTitle('New title from bun')

