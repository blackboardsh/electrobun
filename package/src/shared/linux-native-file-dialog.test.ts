import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const wrapper = readFileSync(
	join(import.meta.dirname, "../native/linux/nativeWrapper.cpp"),
	"utf8",
);
const helper = readFileSync(
	join(import.meta.dirname, "../native/linux/native_file_dialog.h"),
	"utf8",
);

describe("Linux native file dialogs", () => {
	it("uses GtkFileChooserNative for every file chooser path", () => {
		expect(wrapper).not.toContain("gtk_file_chooser_dialog_new");
		expect(wrapper.match(/LinuxNativeFileDialog dialog/g)).toHaveLength(3);
		expect(helper).toContain("gtk_file_chooser_native_new");
		expect(helper).toContain("gtk_native_dialog_set_modal");
		expect(helper).toContain("gtk_native_dialog_run");
	});

	it("retains open, multi-select, folder, save, filters, and cancellation handling", () => {
		expect(wrapper).toContain("FILE_DIALOG_OPEN_MULTIPLE");
		expect(wrapper).toContain("FILE_DIALOG_OPEN_FOLDER");
		expect(wrapper).toContain("FILE_DIALOG_SAVE");
		expect(wrapper).toContain("GTK_FILE_CHOOSER_ACTION_SELECT_FOLDER");
		expect(wrapper).toContain("dialog.setSelectMultiple");
		expect(wrapper).toContain("dialog.setCurrentFolder");
		expect(wrapper).toContain("dialog.setCurrentName");
		expect(wrapper).toContain("dialog.addFilter");
		expect(wrapper).toContain("webkit_file_chooser_request_cancel(request)");
	});

	it("owns the native object and every selected filename allocation", () => {
		expect(helper).toContain("g_object_unref(dialog_)");
		expect(helper).toContain("g_free(current->data)");
		expect(helper).toContain("g_slist_free(filenames)");
	});
});
