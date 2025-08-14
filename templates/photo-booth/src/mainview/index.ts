import Electrobun, { Electroview } from "electrobun/view";
import type { PhotoBoothRPC } from "../bun/index";

// Create RPC client
const rpc = Electroview.defineRPC<PhotoBoothRPC>({
  maxRequestTime: 5000,
  handlers: {
    requests: {},
    messages: {}
  }
});

// Initialize Electrobun with RPC
const electrobun = new Electrobun.Electroview({ rpc });

interface Photo {
    id: string;
    dataUrl: string;
    timestamp: Date;
    type: 'camera' | 'screen';
}

type CaptureMode = 'camera' | 'screen';

class PhotoBooth {
    private video: HTMLVideoElement;
    private canvas: HTMLCanvasElement;
    private captureBtn: HTMLButtonElement;
    private gallery: HTMLElement;
    private cameraSelect: HTMLSelectElement;
    private timerToggle: HTMLInputElement;
    private cameraModeBtn: HTMLButtonElement;
    private screenModeBtn: HTMLButtonElement;
    private startCameraBtn: HTMLButtonElement;
    private selectScreenBtn: HTMLButtonElement;
    private status: HTMLElement;
    private statusText: HTMLElement;
    private countdown: HTMLElement;
    private modal: HTMLElement;
    private modalImage: HTMLImageElement;
    private captureBtnText: HTMLElement;
    private cameraIcon: HTMLElement;
    private screenIcon: HTMLElement;
    
    private stream: MediaStream | null = null;
    private photos: Photo[] = [];
    private currentPhotoId: string | null = null;
    private currentMode: CaptureMode = 'camera';

    constructor() {
        // Get DOM elements
        this.video = document.getElementById('video') as HTMLVideoElement;
        this.canvas = document.getElementById('canvas') as HTMLCanvasElement;
        this.captureBtn = document.getElementById('captureBtn') as HTMLButtonElement;
        this.gallery = document.getElementById('gallery') as HTMLElement;
        this.cameraSelect = document.getElementById('cameraSelect') as HTMLSelectElement;
        this.timerToggle = document.getElementById('timerToggle') as HTMLInputElement;
        this.cameraModeBtn = document.getElementById('cameraModeBtn') as HTMLButtonElement;
        this.screenModeBtn = document.getElementById('screenModeBtn') as HTMLButtonElement;
        this.startCameraBtn = document.getElementById('startCameraBtn') as HTMLButtonElement;
        this.selectScreenBtn = document.getElementById('selectScreenBtn') as HTMLButtonElement;
        this.status = document.getElementById('status') as HTMLElement;
        this.statusText = this.status.querySelector('.status-text') as HTMLElement;
        this.countdown = document.getElementById('countdown') as HTMLElement;
        this.modal = document.getElementById('photoModal') as HTMLElement;
        this.modalImage = document.getElementById('modalImage') as HTMLImageElement;
        this.captureBtnText = this.captureBtn.querySelector('.capture-btn-text') as HTMLElement;
        this.cameraIcon = this.captureBtn.querySelector('.capture-icon-camera') as HTMLElement;
        this.screenIcon = this.captureBtn.querySelector('.capture-icon-screen') as HTMLElement;

        this.initializeEventListeners();
        this.initializeApp();
    }

    private initializeEventListeners() {
        // Mode toggle buttons
        this.cameraModeBtn.addEventListener('click', () => this.setMode('camera'));
        this.screenModeBtn.addEventListener('click', () => this.setMode('screen'));

        // Capture button
        this.captureBtn.addEventListener('click', () => this.capturePhoto());

        // Camera controls
        this.startCameraBtn.addEventListener('click', () => this.startCamera());
        this.cameraSelect.addEventListener('change', (e) => {
            const deviceId = (e.target as HTMLSelectElement).value;
            if (deviceId) {
                this.switchCamera(deviceId);
            }
        });

        // Screen controls
        this.selectScreenBtn.addEventListener('click', () => this.selectScreen());

        // Modal controls
        document.getElementById('modalClose')?.addEventListener('click', () => this.closeModal());
        document.getElementById('downloadBtn')?.addEventListener('click', () => this.saveCurrentPhoto());
        document.getElementById('deleteBtn')?.addEventListener('click', () => this.deleteCurrentPhoto());

        // Close modal on background click
        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal) {
                this.closeModal();
            }
        });
    }

    private async initializeApp() {
        // Set initial mode
        this.setMode('camera');
        
        // Check available cameras
        await this.populateCameraList();
    }

    private setMode(mode: CaptureMode) {
        this.currentMode = mode;
        
        // Update UI classes
        document.body.classList.toggle('mode-screen', mode === 'screen');
        
        // Update mode buttons
        this.cameraModeBtn.classList.toggle('active', mode === 'camera');
        this.screenModeBtn.classList.toggle('active', mode === 'screen');
        
        // Update capture button
        this.cameraIcon.style.display = mode === 'camera' ? 'block' : 'none';
        this.screenIcon.style.display = mode === 'screen' ? 'block' : 'none';
        this.captureBtnText.textContent = mode === 'camera' ? 'Take Photo' : 'Take Screenshot';
        
        // Reset state when switching modes
        this.stopStream();
        this.captureBtn.disabled = true;
        
        // Reset video display and hide any placeholders
        this.video.style.display = 'block';
        const placeholder = this.video.parentElement?.querySelector('.native-capture-placeholder') as HTMLElement;
        if (placeholder) {
            placeholder.style.display = 'none';
        }
        
        // Update status based on mode
        if (mode === 'camera') {
            this.setStatus('Click "Start Camera" to begin', false);
            this.startCameraBtn.style.display = 'flex';
            this.selectScreenBtn.style.display = 'none';
        } else {
            this.setStatus('Screen capture mode - tests getDisplayMedia browser API', false);
            this.selectScreenBtn.style.display = 'flex';
            this.startCameraBtn.style.display = 'none';
        }
    }

    private stopStream() {
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
            this.video.srcObject = null;
        }
    }

    private async populateCameraList() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const videoDevices = devices.filter(device => device.kind === 'videoinput');
            
            // Clear existing options
            this.cameraSelect.innerHTML = '<option value="">Select Camera</option>';
            
            // Add camera options
            videoDevices.forEach((device, index) => {
                const option = document.createElement('option');
                option.value = device.deviceId;
                option.textContent = device.label || `Camera ${index + 1}`;
                this.cameraSelect.appendChild(option);
            });
            
            if (videoDevices.length > 0) {
                this.startCameraBtn.style.display = 'flex';
            } else {
                this.setStatus('No cameras found on this device', false);
            }
        } catch (error) {
            console.error('Error enumerating cameras:', error);
            this.setStatus('Unable to access camera list', false);
        }
    }

    private async startCamera() {
        try {
            const constraints: MediaStreamConstraints = {
                video: {
                    width: { ideal: 1280 },
                    height: { ideal: 720 }
                },
                audio: false
            };

            // If a specific camera is selected, use it
            const selectedCamera = this.cameraSelect.value;
            if (selectedCamera) {
                (constraints.video as MediaTrackConstraints).deviceId = selectedCamera;
            }

            this.stream = await navigator.mediaDevices.getUserMedia(constraints);
            this.video.srcObject = this.stream;

            // Update status and enable capture
            this.setStatus('Camera active - ready to take photos', true);
            this.captureBtn.disabled = false;
            this.startCameraBtn.style.display = 'none';

        } catch (error) {
            console.error('Error starting camera:', error);
            this.setStatus(`Camera error: ${(error as Error).message}`, false);
        }
    }

    private async switchCamera(deviceId: string) {
        if (this.stream) {
            this.stopStream();
        }
        
        try {
            const constraints: MediaStreamConstraints = {
                video: {
                    deviceId: deviceId,
                    width: { ideal: 1280 },
                    height: { ideal: 720 }
                },
                audio: false
            };

            this.stream = await navigator.mediaDevices.getUserMedia(constraints);
            this.video.srcObject = this.stream;
            this.setStatus('Camera switched successfully', true);
            this.captureBtn.disabled = false;
        } catch (error) {
            console.error('Error switching camera:', error);
            this.setStatus('Failed to switch camera', false);
        }
    }

    private async selectScreen() {
        try {
            // Log what's available for debugging
            console.log('Browser capabilities:');
            console.log('  navigator.mediaDevices:', !!navigator.mediaDevices);
            console.log('  getDisplayMedia:', !!(navigator.mediaDevices && (navigator.mediaDevices as any).getDisplayMedia));
            console.log('  getUserMedia:', !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia));
            console.log('  User agent:', navigator.userAgent);
            
            // Check if getDisplayMedia is available
            if (navigator.mediaDevices && (navigator.mediaDevices as any).getDisplayMedia) {
                console.log('getDisplayMedia is available, attempting screen capture');
                
                try {
                    this.stream = await (navigator.mediaDevices as any).getDisplayMedia({
                        video: true,
                        audio: false
                    });
                    
                    this.video.srcObject = this.stream;
                    this.setStatus('Screen capture active - ready to take screenshots', true);
                    this.captureBtn.disabled = false;
                    this.selectScreenBtn.style.display = 'none';

                    // Listen for when the user stops sharing
                    if (this.stream) {
                        const videoTracks = this.stream.getVideoTracks();
                        if (videoTracks.length > 0) {
                            videoTracks[0].addEventListener('ended', () => {
                                this.setStatus('Screen sharing stopped', false);
                                this.captureBtn.disabled = true;
                                this.selectScreenBtn.style.display = 'flex';
                            });
                        }
                    }
                } catch (permissionError) {
                    // Handle permission denial or other getDisplayMedia errors
                    console.log('getDisplayMedia failed:', permissionError);
                    throw new Error(`Screen capture failed: ${(permissionError as Error).message}`);
                }
            } else {
                // getDisplayMedia not available
                console.log('getDisplayMedia not available in this browser');
                throw new Error('getDisplayMedia API is not available in this browser. This may be due to:\n• WKWebView limitations\n• Browser version\n• Security restrictions\n• Platform limitations');
            }
        } catch (error) {
            console.error('Error selecting screen:', error);
            this.setStatus(`Screen capture error: ${(error as Error).message}`, false);
        }
    }

    private async capturePhoto() {
        if (this.currentMode === 'camera') {
            await this.captureCameraPhoto();
        } else {
            await this.captureScreenshot();
        }
    }

    private async captureCameraPhoto() {
        if (!this.stream) {
            this.setStatus('No camera stream available', false);
            return;
        }

        try {
            // Optional timer countdown
            if (this.timerToggle.checked) {
                await this.showCountdown();
            }

            // Capture from video stream
            const context = this.canvas.getContext('2d');
            if (!context) return;

            this.canvas.width = this.video.videoWidth;
            this.canvas.height = this.video.videoHeight;
            context.drawImage(this.video, 0, 0);

            // Convert to data URL
            const dataUrl = this.canvas.toDataURL('image/png');

            // Add to gallery
            const photo: Photo = {
                id: Date.now().toString(),
                dataUrl: dataUrl,
                timestamp: new Date(),
                type: 'camera'
            };

            this.photos.push(photo);
            this.addPhotoToGallery(photo);
            this.setStatus('Photo captured!', true);
            this.playCaptureFeedback();

        } catch (error) {
            console.error('Error capturing photo:', error);
            this.setStatus(`Capture failed: ${(error as Error).message}`, false);
        }
    }

    private async captureScreenshot() {
        try {
            if (this.stream) {
                // We have a screen share stream from getDisplayMedia - capture it
                await this.captureCameraPhoto(); // Same capture logic, but from screen stream
            } else {
                // No stream available - this shouldn't happen if selectScreen worked
                throw new Error('No screen capture stream available. Make sure to select a screen first.');
            }
        } catch (error) {
            console.error('Error capturing screenshot:', error);
            this.setStatus(`Screenshot failed: ${(error as Error).message}`, false);
        }
    }

    private async showCountdown() {
        for (let i = 3; i > 0; i--) {
            this.countdown.textContent = i.toString();
            this.countdown.style.display = 'flex';
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        this.countdown.style.display = 'none';
    }

    private playCaptureFeedback() {
        // Flash effect
        document.body.style.backgroundColor = 'white';
        setTimeout(() => {
            document.body.style.backgroundColor = '';
        }, 100);
    }

    private addPhotoToGallery(photo: Photo) {
        // Remove empty state if it exists
        const emptyState = this.gallery.querySelector('.empty-state');
        if (emptyState) {
            emptyState.remove();
        }

        // Create photo element
        const photoElement = document.createElement('div');
        photoElement.className = 'photo-item';
        photoElement.dataset['photoId'] = photo.id;
        
        const typeIcon = photo.type === 'camera' ? '📷' : '🖥️';
        photoElement.innerHTML = `
            <img src="${photo.dataUrl}" alt="Captured ${photo.type}">
            <div class="photo-info">
                <span class="photo-type">${typeIcon}</span>
                <span class="photo-time">${photo.timestamp.toLocaleTimeString()}</span>
            </div>
        `;

        photoElement.addEventListener('click', () => this.openModal(photo.id));
        this.gallery.insertBefore(photoElement, this.gallery.firstChild);
    }

    private openModal(photoId: string) {
        const photo = this.photos.find(p => p.id === photoId);
        if (!photo) return;

        this.currentPhotoId = photoId;
        this.modalImage.src = photo.dataUrl;
        this.modal.style.display = 'flex';
    }

    private closeModal() {
        this.modal.style.display = 'none';
        this.currentPhotoId = null;
    }

    private async saveCurrentPhoto() {
        if (!this.currentPhotoId) return;

        const photo = this.photos.find(p => p.id === this.currentPhotoId);
        if (!photo) return;

        try {
            const filename = `${photo.type}-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}.png`;
            const result = await electrobun.rpc!.request.savePhoto({
                dataUrl: photo.dataUrl,
                filename: filename
            });

            if (result.success) {
                this.showStatus('Photo saved successfully!', 'success');
                if (result.path) {
                    console.log('Photo saved to:', result.path);
                }
            } else if (result.reason === 'canceled') {
                this.showStatus('Save canceled', 'info');
            } else {
                this.showStatus('Failed to save photo', 'error');
            }
        } catch (error) {
            console.error('Error saving photo:', error);
            this.showStatus('Error saving photo', 'error');
        }
    }

    private deleteCurrentPhoto() {
        if (!this.currentPhotoId) return;

        const photoIndex = this.photos.findIndex(p => p.id === this.currentPhotoId);
        if (photoIndex === -1) return;

        // Remove from array
        this.photos.splice(photoIndex, 1);

        // Remove from DOM
        const photoElement = this.gallery.querySelector(`[data-photo-id="${this.currentPhotoId}"]`);
        if (photoElement) {
            photoElement.remove();
        }

        // Show empty state if no photos left
        if (this.photos.length === 0) {
            this.gallery.innerHTML = `
                <div class="empty-state">
                    No photos/screenshots yet. Take some photos or screenshots to get started!
                </div>
            `;
        }

        this.closeModal();
        this.showStatus('Photo deleted', 'info');
    }

    private setStatus(message: string, active: boolean, error: boolean = false) {
        this.statusText.textContent = message;
        this.status.classList.toggle('active', active && !error);
        this.status.classList.toggle('error', error);
    }

    private showStatus(message: string, type: 'success' | 'error' | 'info') {
        console.log(`[${type}] ${message}`);
        
        // Update status bar temporarily
        const originalText = this.statusText.textContent;
        const originalClasses = this.status.className;
        
        this.setStatus(message, type === 'success', type === 'error');
        
        // Restore original status after 3 seconds
        setTimeout(() => {
            this.statusText.textContent = originalText;
            this.status.className = originalClasses;
        }, 3000);
    }
}

// Initialize the app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new PhotoBooth();
});