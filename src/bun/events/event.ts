export default class ElectrobunEvent<DataType, ResponseType> {
    // todo (yoav): make most of these readonly except for response
    name: string;
    data: DataType;
    response: ResponseType;
    responseWasSet: boolean = false;

    constructor(name: string, data: DataType) {
        this.name = name;
        this.data = data;
    }

    setResponse(response: ResponseType) {
        this.responseWasSet = true;
        this.response = response;
    }
}