/** @type {import('tailwindcss').Config} */
export default {
	content: ["./src/mainview/**/*.{tsx,ts,html}"],
	theme: {
		extend: {
			colors: {
				cyan: { 400: "#00d4ff", 500: "#00b8db" },
				lime: { 400: "#4eff91" },
			},
		},
	},
	plugins: [],
};
