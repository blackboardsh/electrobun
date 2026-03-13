import {
  type JSXElement,
  type Accessor,
  Match,
  Show,
  Switch,
  createSignal,
  // createEffect,
} from "solid-js";
import { setState } from "../store";

export const SettingsPaneSaveClose = ({
  label,
  saveDisabled = () => false,
}: {
  label: string;
  saveDisabled?: () => boolean;
}) => {
  const onCloseClick = (e: MouseEvent) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    setState("settingsPane", { type: "", data: {} });
  };

  return (
    <div
      class="settings-header"
      style="display: flex; flex-direction: row; height: 45px; font-size: 20px; line-height: 45px; padding: 0 10px; align-items: center;"
    >
      <h1 style="font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen-Sans, Ubuntu, Cantarell, 'Helvetica Neue', Helvetica, Arial, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', sans-serif;font-weight: 400;margin: 0 0px 0 0;overflow-x: hidden;text-overflow: ellipsis;white-space: nowrap;padding: 3px 11px;font-size: 20px;line-height: 1.34;">
        {label}
      </h1>
      <div
        class="actions"
        style="display: flex;-webkit-box-flex: 1;-ms-flex-positive: 1;flex-grow: 1;-ms-flex-negative: 0;flex-shrink: 0;-webkit-box-pack: end;-ms-flex-pack: end;justify-content: flex-end;-webkit-box-align: center;-ms-flex-align: center;align-items: center;"
      ></div>
      <div style="flex-grow: 0;margin-left: 8px;     display: -webkit-box;display: -ms-flexbox;display: flex;-webkit-box-flex: 1;-ms-flex-positive: 1;flex-grow: 1;-ms-flex-negative: 0;flex-shrink: 0;-webkit-box-pack: end;-ms-flex-pack: end;justify-content: flex-end;-webkit-box-align: center;-ms-flex-align: center;align-items: center;">
        <button
          type="button"
          onClick={onCloseClick}
          style="border-color: rgb(54, 54, 54);outline: 0px;cursor: default;-webkit-user-select: none;padding: 0px 12px;font-family: inherit;font-size: 12px;position: relative;display: flex;align-items: center;justify-content: center;height: 32px;border-radius: 2px;color: rgb(235, 235, 235);background: rgb(94, 94, 94);border-width: 1px;border-style: solid;box-sizing: border-box;align-self: center;"
        >
          Close
        </button>
        <button
          disabled={saveDisabled()}
          type="submit"
          style={`border-color: rgb(54, 54, 54);outline: 0px;cursor: default;-webkit-user-select: none;margin-left: 8px;padding: 0px 12px;font-family: inherit;font-size: 12px;position: relative;display: flex;align-items: center;justify-content: center;height: 32px;border-radius: 2px 0px 0px 2px;color: rgb(255, 255, 255);background: ${
            saveDisabled() ? "#ccc" : "rgb(0, 115, 230)"
          };border-width: 1px 0px 1px 1px;border-style: solid;box-sizing: border-box;align-self: center;`}
        >
          Save
        </button>
      </div>
    </div>
  );
};

export const SettingsPaneFormSection = ({
  label,
  children,
}: {
  label: string | Accessor<string>;
  children: JSXElement;
}) => {
  const [open, setOpen] = createSignal(true);
  // const [_label, setLabel] = createSignal(label);
  const getLabel = () => {
    return typeof label === "function" ? label() : label;
  };

  // createEffect(() => {
  //   console.log("label changing", label);
  //   setLabel(label);
  // });
  return (
    <div class="form-section">
      <div
        class="form-section-header"
        style="outline: 0px;cursor: default;-webkit-user-select: none;"
        onClick={() => setOpen(!open())}
      >
        <div style="padding: 7px 4px;display: flex;align-items: center;background-color: rgb(43, 43, 43);font-size: 12px;font-weight: bold;line-height: 16px;border-width: 1px 0px;border-style: solid;border-top-color: rgb(33, 33, 33);border-bottom-color: rgb(33, 33, 33);">
          <div class="arrow" style="padding-right: 4px;">
            <Switch>
              <Match when={open()}>
                <svg
                  data-icon="CaretDownMedium"
                  aria-hidden="true"
                  // focusable="false"
                  width="9"
                  height="6"
                  viewBox="0 0 9 6"
                  class="bem-Svg"
                  style="display: block; width: 12px; height: 12px;"
                >
                  <path fill="currentColor" d="M4.5 5L1 1h7z"></path>
                </svg>
              </Match>
              <Match when={!open()}>
                <svg
                  data-icon="CaretLeftMedium"
                  aria-hidden="true"
                  // focusable="false"
                  width="6"
                  height="9"
                  viewBox="0 0 6 9"
                  class="bem-Svg"
                  style="display: block; width: 12px; height: 12px;"
                >
                  <path fill="currentColor" d="M5 4.5l-4 4V1z"></path>
                </svg>
              </Match>
            </Switch>
          </div>
          <div class="section-title">{getLabel()}</div>
        </div>
      </div>
      <Show when={open()}>
        <div class="form-section-body" style="padding: 16px;">
          {children}
        </div>
      </Show>
    </div>
  );
};

export const SettingsPaneField = ({
  label,
  children,
}: {
  label: string | Accessor<string>;
  children: JSXElement;
}) => {
  return (
    <div class="field" style="margin-top: 8px;">
      <div style="display: flex;flex-direction: column;">
        <div
          class="field-head"
          style="display: flex;-webkit-box-align: end;-ms-flex-align: end;align-items: flex-end;-ms-flex-wrap: wrap;flex-wrap: wrap;margin-bottom: 8px;"
        >
          <div style="box-sizing: border-box;color: rgb(217, 217, 217);cursor: default;display: block;font-family: Inter, -apple-system, 'system-ui', 'Segoe UI', Roboto, Oxygen-Sans, Ubuntu, Cantarell, 'Helvetica Neue', Helvetica, Arial, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', sans-serif;font-size: 12px;height: 16px;line-height: 16px;max-width: 100%;overflow-x: hidden;overflow-y: hidden;pointer-events: auto;text-overflow: ellipsis;text-size-adjust: 100%;user-select: text;white-space: nowrap;">
            {typeof label === "function" ? label() : label}
          </div>
        </div>
        {children}
      </div>
    </div>
  );
};

export const SettingsInputField = ({
  value,
  placeholder,
  name,
  ref,
}: {
  value: string;
  placeholder: string;
  // onInput: (e: Event) => void,
  name: string;
  ref: HTMLInputElement | undefined;
}) => {
  return (
    <input
      type="text"
      ref={ref}
      name={name}
      value={value}
      // onInput={onInput}
      placeholder={placeholder}
      style="background: #2b2b2b;border-radius: #2b2b2b;border: 1px solid #212121;color: #d9d9d9;outline: none;cursor: text;display: block;font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen-Sans, Ubuntu, Cantarell, 'Helvetica Neue', Helvetica, Arial, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', sans-serif;font-size: 12px;padding-top: 8px;padding-right: 9px;padding-bottom: 8px;padding-left: 9px;line-height: 14px;"
    ></input>
  );
};

export const SettingsReadonlyField = ({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) => {
  return (
    <span
      style="background: #202020;
    padding-top: 5px;
    padding-right: 9px;
    padding-bottom: 5px;
    padding-left: 9px;
    margin-bottom: '4px'
    -webkit-user-select: none;
    line-height: 14px;"
    >
      {label}:
      <span
        style="background: #2b2b2b;
        padding-top: 2px;
        padding-right: 9px;
        padding-bottom: 2px;
        padding-left: 9px;
        line-height: 22px;
        color: #d9d9d9;
        font-size: 12px;
      word-break: break-all;
      -webkit-user-select: text;
      margin-left: 5px;
      "
      >
        {value}
      </span>
    </span>
  );
};
