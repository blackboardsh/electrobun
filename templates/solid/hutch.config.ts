// @hutch cli=0.5.1 cottontail=0.3.0
export default {
	packageManager: "npm",
	scripts: {
		install: ["hutch", "pm", "ci"],
		start: "hutch pm exec -- vite build && hutch electrobun dev",
		dev: "hutch pm exec -- vite build && hutch electrobun dev --watch",
		"dev:hmr": ["hutch", "pm", "exec", "--", "concurrently", "hutch run hmr", "hutch run start"],
		hmr: ["hutch", "pm", "exec", "--", "vite", "--port", "5173"],
		build: "hutch pm exec -- vite build && hutch electrobun build --env=production",
		"build:canary": "hutch pm exec -- vite build && hutch electrobun build --env=canary",
	},
};
