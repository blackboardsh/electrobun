import { RpcStatus } from "@mainview/components/rpc-status";
import { useRpc } from "@mainview/lib/rpc";

export function App() {
    const { handlerRpc } = useRpc();

    const handleSayHello = async () => {
        await handlerRpc.greet({});
    };

    return (
        <div className="w-full h-screen flex items-center justify-center">
            <div className="flex h-80 flex-col  px-12 text-center">
                <h1 className="text-2xl font-medium tracking-tight">
                    Electrobun + React
                </h1>
                <p className="mt-3 text-muted">
                    Get started by editing{" "}
                    <code className="font-mono text-sm text-foreground">
                        src/mainview/app.tsx
                    </code>
                </p>

                <div className="mt-8">
                    <RpcStatus />
                </div>

                <div className="mt-12 grid w-full max-w-md grid-cols-2 gap-4 text-left">
                    <div className="rounded-lg bg-surface p-4">
                        <p className="text-sm font-medium">Build</p>
                        <code className="mt-2 block font-mono text-xs leading-relaxed text-muted">
                            hutch run dev
                        </code>
                    </div>
                    <div className="rounded-lg bg-surface p-4">
                        <p className="text-sm font-medium">Included</p>
                        <p className="mt-2 text-xs leading-relaxed text-muted">
                            React 19 · Tailwind 4
                            <br />
                            Electrobun RPC · Vite 8
                        </p>
                    </div>
                    <div className="col-span-2 w-full flex justify-center">
                        <button
                            className="px-3 py-2 bg-white text-black rounded-full text-xs w-20 mx-auto hover:bg-white/80 transition duration-300 ease-in-out"
                            onClick={handleSayHello}
                        >
                            Say hello
                        </button>
                    </div>
                </div>

                <div className="mt-auto flex justify-center gap-6 pt-8 text-sm text-muted">
                    <a
                        href="https://framework.blackboard.sh/"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="transition-colors hover:text-foreground"
                    >
                        Electrobun Docs
                    </a>
                    <a
                        href="https://react.dev/"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="transition-colors hover:text-foreground"
                    >
                        React Docs
                    </a>
                </div>
            </div>
        </div>
    );
}
