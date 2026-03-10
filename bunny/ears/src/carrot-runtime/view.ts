import Electrobun, { Electroview } from "electrobun/view";
import type { CarrotPermission, CarrotViewRPC } from "./types";

type RuntimeEventHandler = (payload: unknown) => void;

export function createCarrotClient() {
  const eventHandlers = new Map<string, Set<RuntimeEventHandler>>();
  let bootInfo: {
    id: string;
    name: string;
    permissions: CarrotPermission[];
    mode: "window" | "background";
  } | null = null;

  const rpc = Electroview.defineRPC<CarrotViewRPC>({
    maxRequestTime: 10000,
    handlers: {
      requests: {},
      messages: {
        carrotBoot: (payload) => {
          bootInfo = payload;
          dispatch("boot", payload);
        },
        runtimeEvent: ({ name, payload }) => {
          dispatch(name, payload);
        }
      }
    }
  });

  const electroview = new Electrobun.Electroview({ rpc });

  function dispatch(name: string, payload: unknown) {
    eventHandlers.get(name)?.forEach((handler) => handler(payload));
  }

  return {
    rpc,
    electroview,
    get bootInfo() {
      return bootInfo;
    },
    hasPermission(permission: CarrotPermission) {
      return bootInfo?.permissions.includes(permission) ?? false;
    },
    invoke<T = unknown>(method: string, params?: unknown): Promise<T> {
      return electroview.rpc!.request.invoke({ method, params }) as Promise<T>;
    },
    on(name: string, handler: RuntimeEventHandler) {
      const handlers = eventHandlers.get(name) ?? new Set<RuntimeEventHandler>();
      handlers.add(handler);
      eventHandlers.set(name, handlers);
      return () => {
        handlers.delete(handler);
      };
    }
  };
}
