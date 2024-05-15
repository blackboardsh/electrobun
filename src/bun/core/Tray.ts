import { zigRPC } from "../proc/zig";
import electrobunEventEmitter from "../events/eventEmitter";

let nextTrayId = 1;
const TrayMap = {};

type ConstructorOptions = {
  title?: string;
  image?: string;
};

export class Tray {
  id: number = nextTrayId++;

  constructor({ title = "", image = "" }: ConstructorOptions = {}) {
    zigRPC.request.createTray({ id: this.id, title, image });

    TrayMap[this.id] = this;
  }

  setTitle(title: string) {
    zigRPC.request.setTrayTitle({ id: this.id, title });
  }

  setImage(image: string) {
    zigRPC.request.setTrayImage({ id: this.id, image });
  }

  on(name: "tray-clicked", handler) {
    const specificName = `${name}-${this.id}`;
    electrobunEventEmitter.on(specificName, handler);
  }

  static getById(id: number) {
    return TrayMap[id];
  }

  static getAll() {
    return Object.values(TrayMap);
  }
}
