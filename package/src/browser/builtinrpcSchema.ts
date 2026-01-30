// consider just makeing a shared types file

export type BuiltinBunToWebviewSchema = {
	requests: {
		evaluateJavascriptWithResponse: {
			params: { script: string };
			response: any;
		};
	};
};

export type BuiltinWebviewToBunSchema = {
	requests: {
		webviewTagInit: {
			params: {};
			response: any;
		};
	};
};
