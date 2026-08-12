// @hutch cli=0.6.4 cottontail=0.4.1
export default {
	electrobun: {
		version: "2.0.0",
	},
	packageManager: "npm",
	scripts: {
		install: ["hutch", "pm", "ci"],
		start: "hutch electrobun sync && hutch pm exec -- vite build && hutch electrobun dev",
		dev: "hutch electrobun sync && hutch pm exec -- vite build && hutch electrobun dev --watch",
		"dev:hmr": ["hutch", "pm", "exec", "--", "concurrently", "hutch run hmr", "hutch run start"],
		hmr: "hutch electrobun sync && hutch pm exec -- vite --port 5173",
		build: "hutch electrobun sync && hutch pm exec -- vite build && hutch electrobun build --env=production",
		"build:canary": "hutch electrobun sync && hutch pm exec -- vite build && hutch electrobun build --env=canary",
	},
};
