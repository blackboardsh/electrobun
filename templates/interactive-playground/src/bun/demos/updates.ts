import Electrobun from "electrobun/bun";

class UpdateManager {
  async checkForUpdates() {
    try {
      const updateInfo = await Electrobun.Updater.checkForUpdate();
      
      this.onUpdateStatus?.({
        status: 'checked',
        progress: 100
      });

      return {
        updateAvailable: updateInfo.updateAvailable,
        currentVersion: Electrobun.Updater.getLocalVersion?.() || "0.0.19-beta.118",
        latestVersion: updateInfo.latestVersion,
      };
    } catch (error) {
      console.error("Update check error:", error);
      
      this.onUpdateStatus?.({
        status: 'error',
        progress: 0
      });

      return {
        updateAvailable: false,
        currentVersion: "0.0.19-beta.118",
        error: error.message
      };
    }
  }

  async downloadUpdate() {
    try {
      this.onUpdateStatus?.({
        status: 'downloading',
        progress: 0
      });

      // Simulate download progress
      for (let i = 0; i <= 100; i += 10) {
        await new Promise(resolve => setTimeout(resolve, 200));
        this.onUpdateStatus?.({
          status: 'downloading',
          progress: i
        });
      }

      await Electrobun.Updater.downloadUpdate();
      
      this.onUpdateStatus?.({
        status: 'downloaded',
        progress: 100
      });

      return { success: true };
    } catch (error) {
      console.error("Update download error:", error);
      
      this.onUpdateStatus?.({
        status: 'error',
        progress: 0
      });

      return { success: false, error: error.message };
    }
  }

  async applyUpdate() {
    try {
      this.onUpdateStatus?.({
        status: 'applying',
        progress: 50
      });

      await Electrobun.Updater.applyUpdate();
      
      this.onUpdateStatus?.({
        status: 'applied',
        progress: 100
      });

      return { success: true };
    } catch (error) {
      console.error("Update apply error:", error);
      
      this.onUpdateStatus?.({
        status: 'error',
        progress: 0
      });

      return { success: false, error: error.message };
    }
  }

  getUpdateInfo() {
    return Electrobun.Updater.updateInfo?.() || null;
  }

  // Event callbacks
  onUpdateStatus?: (data: { status: string; progress?: number }) => void;
}

export const updateManager = new UpdateManager();