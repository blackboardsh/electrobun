// @hutch cli=0.12.0 cottontail=0.5.0
export default {
	electrobun: {
		version: "2.0.1-beta.15",
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
