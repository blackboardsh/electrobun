export type CustomSchemePrivileges = {
	standard?: boolean;
	secure?: boolean;
	bypassCSP?: boolean;
	allowServiceWorkers?: boolean;
	supportFetchAPI?: boolean;
	corsEnabled?: boolean;
	stream?: boolean;
	codeCache?: boolean;
};

export type CustomScheme = {
	scheme: string;
	privileges?: CustomSchemePrivileges;
};

export type ProtocolHandler = (request: Request) => Response | Promise<Response>;
