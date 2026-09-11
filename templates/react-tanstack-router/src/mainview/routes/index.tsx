import { useRpc } from "@/hooks/use-rpc";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  const rpc = useRpc();

  const handlePing = () => {
    rpc.send.ping({ params: {} });
  };

  return (
    <main className="space-y-2 p-2">
      <h3>Welcome Home!</h3>
      <button className="bg-blue-500 px-4 py-2 rounded-lg" onClick={handlePing}>
        Ping
      </button>
    </main>
  );
}
