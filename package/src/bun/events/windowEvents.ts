import ElectrobunEvent from "./event";

export default {
  close: (data) => new ElectrobunEvent<{ id: number }, {}>("close", data),
  resize: (data) =>
    new ElectrobunEvent<
      { id: number; x: number; y: number; width: number; height: number },
      {}
    >("resize", data),
  move: (data) =>
    new ElectrobunEvent<{ id: number; x: number; y: number }, {}>("move", data),
  focus: (data) => new ElectrobunEvent<{ id: number }, {}>("focus", data),
};
