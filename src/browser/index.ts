const electrobun = {
    bunBridge: (msg) => {
        // todo (yoav): rpc anywhere
        window.webkit.messageHandlers.bunBridge.postMessage(msg);
    }
}

window.electrobun = electrobun;


