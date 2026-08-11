// @hutch cli=0.5.1 cottontail=0.3.0
export default {
	scripts: {
		install: ["npm", "ci"],
		start: "npm exec -- vite build && hutch electrobun dev",
		dev: "npm exec -- vite build && hutch electrobun dev --watch",
		"dev:hmr": ["npm", "exec", "--", "concurrently", "hutch run hmr", "hutch run start"],
		hmr: ["npm", "exec", "--", "vite", "--port", "5173"],
		build: "npm exec -- vite build && hutch electrobun build --env=production",
		"build:canary": "npm exec -- vite build && hutch electrobun build --env=canary",
	},
};
