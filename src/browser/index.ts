const electrobun = {
    bunBridge: (msg) => {
        // todo (yoav): rpc anywhere
        window.webkit.messageHandlers.bunBridge.postMessage(msg);
    },
    receiveMessageFromBun: (msg) => {
        // todo (yoav): rpc anywhere
        document.body.innerHTML = msg.msg;
    }
}

window.electrobun = electrobun;


