export class FileDemo {
  private selectedFiles: string[] = [];

  render() {
    return `
      <div class="demo-section">
        <div class="demo-header">
          <span class="demo-icon">🗂️</span>
          <div>
            <h2 class="demo-title">File Operations</h2>
            <p class="demo-description">Test file dialogs, file system operations, and drag & drop functionality</p>
          </div>
        </div>

        <div class="demo-controls">
          <h3>File Dialog</h3>
          <div class="control-group">
            <label class="control-checkbox">
              <input type="checkbox" id="file-multiple"> Allow multiple selection
            </label>
            
            <label class="control-label">File Types:</label>
            <select id="file-types" class="control-input" style="width: 150px;">
              <option value="">All Files (*)</option>
              <option value="txt,md">Text Files</option>
              <option value="png,jpg,jpeg,gif">Images</option>
              <option value="pdf">PDF Files</option>
              <option value="json,js,ts">Code Files</option>
            </select>
            
            <button class="btn btn-primary" id="open-file-dialog">Open File Dialog</button>
          </div>

          <h3>File Operations</h3>
          <div class="control-group">
            <button class="btn btn-secondary" id="move-to-trash" disabled>Move Selected to Trash</button>
            <button class="btn btn-secondary" id="show-in-finder" disabled>Show in Finder</button>
          </div>

          <h3>Drag & Drop Test</h3>
          <div class="drop-zone" id="drop-zone" style="border: 2px dashed #cbd5e0; border-radius: 0.5rem; padding: 2rem; text-align: center; color: #718096; margin: 1rem 0; background: #f7fafc;">
            <div>📁 Drag and drop files here</div>
            <div style="font-size: 0.875rem; margin-top: 0.5rem;">Or click "Open File Dialog" above</div>
          </div>
        </div>

        <div class="demo-results">
          <div class="results-header">Selected Files (<span id="file-count">0</span>):</div>
          <div id="file-list" class="file-list">
            <div class="no-files" style="text-align: center; color: #718096; padding: 2rem;">
              No files selected yet.
            </div>
          </div>
        </div>
      </div>
    `;
  }

  initialize(rpc: any) {
    const openDialogBtn = document.getElementById('open-file-dialog');
    const moveToTrashBtn = document.getElementById('move-to-trash');
    const showInFinderBtn = document.getElementById('show-in-finder');
    const dropZone = document.getElementById('drop-zone');

    openDialogBtn?.addEventListener('click', async () => {
      const multiple = (document.getElementById('file-multiple') as HTMLInputElement).checked;
      const fileTypes = (document.getElementById('file-types') as HTMLSelectElement).value;
      
      try {
        const files = await rpc.request.openFileDialog({
          multiple,
          fileTypes: fileTypes ? fileTypes.split(',') : undefined
        });
        
        this.selectedFiles = files;
        this.updateFileList();
      } catch (error) {
        console.error('Error opening file dialog:', error);
      }
    });

    moveToTrashBtn?.addEventListener('click', async () => {
      if (this.selectedFiles.length === 0) return;
      
      const confirmed = confirm(`Are you sure you want to move ${this.selectedFiles.length} file(s) to trash?`);
      if (!confirmed) return;

      for (const file of this.selectedFiles) {
        try {
          await rpc.request.moveToTrash(file);
        } catch (error) {
          console.error(`Error moving ${file} to trash:`, error);
        }
      }
      
      this.selectedFiles = [];
      this.updateFileList();
    });

    showInFinderBtn?.addEventListener('click', async () => {
      if (this.selectedFiles.length === 0) return;
      
      // Show the first selected file in finder
      try {
        await rpc.request.showInFinder(this.selectedFiles[0]);
      } catch (error) {
        console.error('Error showing in finder:', error);
      }
    });

    // Set up drag and drop
    if (dropZone) {
      this.setupDragAndDrop(dropZone);
    }
  }

  private setupDragAndDrop(dropZone: HTMLElement) {
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
      dropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
    });

    ['dragenter', 'dragover'].forEach(eventName => {
      dropZone.addEventListener(eventName, () => {
        dropZone.style.background = '#ebf8ff';
        dropZone.style.borderColor = '#4299e1';
      });
    });

    ['dragleave', 'drop'].forEach(eventName => {
      dropZone.addEventListener(eventName, () => {
        dropZone.style.background = '#f7fafc';
        dropZone.style.borderColor = '#cbd5e0';
      });
    });

    dropZone.addEventListener('drop', (e) => {
      const dt = e.dataTransfer;
      if (!dt) return;

      const files = Array.from(dt.files).map(file => file.path || file.name);
      this.selectedFiles = files;
      this.updateFileList();
    });
  }

  private updateFileList() {
    const container = document.getElementById('file-list');
    const count = document.getElementById('file-count');
    const moveToTrashBtn = document.getElementById('move-to-trash');
    const showInFinderBtn = document.getElementById('show-in-finder');
    
    if (!container || !count) return;

    count.textContent = this.selectedFiles.length.toString();

    // Enable/disable action buttons
    const hasFiles = this.selectedFiles.length > 0;
    moveToTrashBtn?.toggleAttribute('disabled', !hasFiles);
    showInFinderBtn?.toggleAttribute('disabled', !hasFiles);

    if (this.selectedFiles.length === 0) {
      container.innerHTML = `
        <div class="no-files" style="text-align: center; color: #718096; padding: 2rem;">
          No files selected yet.
        </div>
      `;
      return;
    }

    container.innerHTML = this.selectedFiles.map((file, index) => `
      <div class="file-item" style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 0.5rem; padding: 1rem; margin-bottom: 0.5rem;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div style="flex: 1; min-width: 0;">
            <div style="font-weight: 500; color: #2d3748; margin-bottom: 0.25rem;">
              ${this.getFileName(file)}
            </div>
            <div style="color: #718096; font-size: 0.875rem; word-break: break-all;">
              ${file}
            </div>
          </div>
          <div style="margin-left: 1rem;">
            <button class="btn btn-small btn-secondary remove-file" data-index="${index}">Remove</button>
          </div>
        </div>
      </div>
    `).join('');

    // Add remove button listeners
    const removeButtons = document.querySelectorAll('.remove-file');
    removeButtons.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const index = parseInt((e.target as HTMLElement).getAttribute('data-index') || '0');
        this.selectedFiles.splice(index, 1);
        this.updateFileList();
      });
    });
  }

  private getFileName(path: string): string {
    return path.split('/').pop() || path.split('\\').pop() || path;
  }

  // Handle events from the backend
  onFileSelected(data: { paths: string[] }) {
    this.selectedFiles = data.paths;
    this.updateFileList();
  }
}