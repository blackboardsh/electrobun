import { handlerRpc } from "@mainview/lib/rpc";
import { useEffect, useState } from "react";

export function RpcStatus() {
    const [connected, setConnected] = useState(false);
    const [mode, setMode] = useState<string>("");

    useEffect(() => {
        handlerRpc()
            .status({})
            .then((res) => {
                setConnected(true);
                setMode(res.mode);
            })
            .catch(() => setConnected(false));
    }, []);

    if (!connected) {
        return (
            <span className="inline-flex items-center gap-2 text-sm text-muted">
                <span className="inline-block size-2 rounded-full bg-muted animate-pulse" />
                Connecting…
            </span>
        );
    }

    return (
        <span className="inline-flex items-center gap-2 text-sm text-muted">
            <span className="inline-block size-2 rounded-full bg-green-500" />
            Connected to Bun
            {mode === "development" && (
                <span className="rounded bg-surface px-1.5 py-0.5 border border-border font-mono text-xs text-muted">
                    dev
                </span>
            )}
        </span>
    );
}
