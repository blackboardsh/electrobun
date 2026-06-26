import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/about")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <main className="p-2">
      <h2>Hello "/about"!</h2>
    </main>
  );
}
