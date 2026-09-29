import { Electroview } from "electrobun/view";
import type { AcceptanceRPC } from "../rpc";

const rpc = Electroview.defineRPC<AcceptanceRPC>({ handlers: { requests: {}, messages: {} } });
const view = new Electroview({ rpc });
const text = "Renderer → native Ω";
const token = await view.rpc!.request.challenge({ text });
document.querySelector("#status")!.textContent = "RPC round trip passed";
view.rpc!.send.complete({ token, text });
