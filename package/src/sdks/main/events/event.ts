export default class ElectrobunEvent<DataType, ResponseType> {
	// todo (yoav): make most of these readonly except for response
	name: string;
	data: DataType;
	// todo (yoav): define getters and setters for response
	_response: ResponseType | undefined;
	responseWasSet: boolean = false;

	constructor(name: string, data: DataType) {
		this.name = name;
		this.data = data;
	}

	// Getter for response
	get response(): ResponseType | undefined {
		return this._response;
	}

	// Setter for response
	set response(value: ResponseType) {
		this._response = value;
		this.responseWasSet = true; // Update flag when response is set
	}

	clearResponse() {
		this._response = undefined;
		this.responseWasSet = false;
	}
}
