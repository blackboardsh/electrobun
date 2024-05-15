import EventEmitter from "events";
import webviewEvents from "./webviewEvents";
import trayEvents from "./trayEvents";
import ElectrobunEvent from "./event";

class ElectrobunEventEmitter extends EventEmitter {
  constructor() {
    super();
  }

  // optionally pass in a specifier to make the event name specific.
  // eg: will-navigate is listened to globally for all webviews, but
  // will-navigate-1 is listened to for a specific webview with id 1
  emitEvent(
    ElectrobunEvent: ElectrobunEvent<any, any>,
    specifier?: number | string
  ) {
    if (specifier) {
      this.emit(`${ElectrobunEvent.name}-${specifier}`, ElectrobunEvent);
    } else {
      this.emit(ElectrobunEvent.name, ElectrobunEvent);
    }
  }

  events = {
    webview: {
      ...webviewEvents,
    },
    tray: {
      ...trayEvents,
    },
  };
}

export const electrobunEventEmitter = new ElectrobunEventEmitter();

export default electrobunEventEmitter;
