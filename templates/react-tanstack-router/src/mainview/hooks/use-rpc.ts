import { Electroview } from "electrobun/view"
import type { AppRPC } from "@shared/types/rpc"

const rpc = Electroview.defineRPC<AppRPC>({ handlers: {} })
const electrobun = new Electroview({ rpc })

export const useRpc = () => electrobun.rpc!
