import { Utils } from "electrobun/bun";
import { join } from "path";
import { homedir } from "os";

class FileManager {
  async openFileDialog(options: {
    multiple?: boolean;
    fileTypes?: string[];
    startingFolder?: string;
  }) {
    try {
      const result = await Utils.openFileDialog({
        startingFolder: options.startingFolder || join(homedir(), "Desktop"),
        allowedFileTypes: options.fileTypes?.join(",") || "*",
        canChooseFiles: true,
        canChooseDirectory: false,
        allowsMultipleSelection: options.multiple || false,
      });

      // Filter out empty strings
      const filteredResult = result.filter(path => path.trim() !== "");
      this.onFileSelected?.(filteredResult);
      
      return filteredResult;
    } catch (error) {
      console.error("File dialog error:", error);
      return [];
    }
  }

  async moveToTrash(path: string) {
    try {
      await Utils.moveToTrash(path);
      this.onSystemEvent?.({ 
        type: 'file-trashed', 
        details: { path, success: true } 
      });
    } catch (error) {
      console.error("Move to trash error:", error);
      this.onSystemEvent?.({ 
        type: 'file-trashed', 
        details: { path, success: false, error: error.message } 
      });
      throw error;
    }
  }

  async showInFinder(path: string) {
    try {
      await Utils.showItemInFolder(path);
      this.onSystemEvent?.({ 
        type: 'show-in-finder', 
        details: { path, success: true } 
      });
    } catch (error) {
      console.error("Show in finder error:", error);
      this.onSystemEvent?.({ 
        type: 'show-in-finder', 
        details: { path, success: false, error: error.message } 
      });
      throw error;
    }
  }

  // Event callbacks
  onFileSelected?: (paths: string[]) => void;
  onSystemEvent?: (event: { type: string; details: any }) => void;
}

export const fileManager = new FileManager();