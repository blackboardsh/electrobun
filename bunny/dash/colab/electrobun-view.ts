import ActualElectrobun, {
  createRPC,
  type RPCSchema,
  type ElectrobunRPCSchema,
  type ElectrobunRPCConfig,
  type WebviewTagElement,
  type WebviewEventTypes,
  type WgpuTagElement,
  type WgpuEventTypes,
} from "../../ears/node_modules/electrobun/dist/api/browser/index.ts";
import { createCarrotClient } from "bunny-ears/view";

const carrotClient = createCarrotClient();

type RPCConfigLike = {
  handlers?: {
    messages?: Record<string, (payload: unknown) => unknown>;
  };
};

function makeRequestProxy() {
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "then") {
          return undefined;
        }

        return (params?: unknown) => carrotClient.invoke(String(property), params);
      },
    },
  );
}

function makeSendProxy() {
  const send = (messageName: string, payload?: unknown) => {
    carrotClient.invoke(`send:${messageName}`, payload).catch((error) => {
      console.error(`[bunny-dash] send ${messageName} failed`, error);
    });
  };

  return new Proxy(send, {
    get(_target, property) {
      if (property === "then") {
        return undefined;
      }

      return (payload?: unknown) => send(String(property), payload);
    },
    apply(_target, _thisArg, args) {
      const [messageName, payload] = args as [string, unknown];
      send(String(messageName), payload);
      return undefined;
    },
  });
}

class Electroview<T extends { request?: unknown; send?: unknown } = any> {
  rpc?: T;

  constructor(config: { rpc: RPCConfigLike }) {
    const messageHandlers = config.rpc?.handlers?.messages || {};
    for (const [messageName, handler] of Object.entries(messageHandlers)) {
      carrotClient.on(messageName, (payload) => {
        try {
          handler(payload);
        } catch (error) {
          console.error(`[bunny-dash] renderer message handler failed: ${messageName}`, error);
        }
      });
    }

    this.rpc = {
      request: makeRequestProxy(),
      send: makeSendProxy(),
    } as T;
  }

  static defineRPC<Schema extends ElectrobunRPCSchema>(
    config: ElectrobunRPCConfig<Schema, "webview">,
  ) {
    return config as unknown as RPCConfigLike;
  }
}

const Electrobun = {
  ...(ActualElectrobun as Record<string, unknown>),
  Electroview,
};

export {
  createRPC,
  Electroview,
  type RPCSchema,
  type ElectrobunRPCSchema,
  type ElectrobunRPCConfig,
  type WebviewTagElement,
  type WebviewEventTypes,
  type WgpuTagElement,
  type WgpuEventTypes,
};

export default Electrobun;
