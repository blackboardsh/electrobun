export default {
	scripts: {
		install: ["hutch", "install", "--frozen-lockfile"],
		start: "hutch electrobun sync && hutch pm exec -- vite build && hutch electrobun dev",
		dev: "hutch electrobun sync && hutch pm exec -- vite build && hutch electrobun dev --watch",
		"dev:hmr": ["hutch", "pm", "exec", "--", "concurrently", "hutch run hmr", "hutch run start"],
		hmr: "hutch electrobun sync && hutch pm exec -- vite --port 5173",
		build: "hutch electrobun sync && hutch pm exec -- vite build && hutch electrobun build --env=stable",
		"build:canary": "hutch electrobun sync && hutch pm exec -- vite build && hutch electrobun build --env=canary",
	},
};
