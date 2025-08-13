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

const electrobun = new Electrobun.Electroview({ rpc });

interface Photo {
    id: string;
    dataUrl: string;
    timestamp: Date;
}

class PhotoBooth {
    private video: HTMLVideoElement;
    private canvas: HTMLCanvasElement;
    private captureBtn: HTMLButtonElement;
    private gallery: HTMLElement;
    private cameraSelect: HTMLSelectElement;
    private timerToggle: HTMLInputElement;
    private changeSourceBtn: HTMLButtonElement;
    private status: HTMLElement;
    private statusText: HTMLElement;
    private countdown: HTMLElement;
    private modal: HTMLElement;
    private modalImage: HTMLImageElement;
    
    private stream: MediaStream | null = null;
    private photos: Photo[] = [];
    private currentPhotoId: string | null = null;

    constructor() {
        // Get DOM elements
        this.video = document.getElementById('video') as HTMLVideoElement;
        this.canvas = document.getElementById('canvas') as HTMLCanvasElement;
        this.captureBtn = document.getElementById('captureBtn') as HTMLButtonElement;
        this.gallery = document.getElementById('gallery') as HTMLElement;
        this.cameraSelect = document.getElementById('cameraSelect') as HTMLSelectElement;
        this.timerToggle = document.getElementById('timerToggle') as HTMLInputElement;
        this.changeSourceBtn = document.getElementById('changeSourceBtn') as HTMLButtonElement;
        this.status = document.getElementById('status') as HTMLElement;
        this.statusText = this.status.querySelector('.status-text') as HTMLElement;
        this.countdown = document.getElementById('countdown') as HTMLElement;
        this.modal = document.getElementById('photoModal') as HTMLElement;
        this.modalImage = document.getElementById('modalImage') as HTMLImageElement;

        this.initializeEventListeners();
        this.initializeCamera();
    }

    private initializeEventListeners() {
        // Capture button
        this.captureBtn.addEventListener('click', (e) => {
            console.log('Capture button clicked - event:', e);
            this.capturePhoto();
        });

        // Camera selector
        this.cameraSelect.addEventListener('change', (e) => {
            const deviceId = (e.target as HTMLSelectElement).value;
            if (deviceId) {
                this.switchCamera(deviceId);
            }
        });

        // Change source button for screen capture
        this.changeSourceBtn.addEventListener('click', (e) => {
            console.log('Change source button clicked - event:', e);
            e.preventDefault();
            this.changeScreenSource();
        });

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

        // No need to listen for results - we'll handle them in saveCurrentPhoto
    }

    private async initializeCamera() {
        try {
            // First, get available cameras without requesting permission
            await this.getAvailableCameras();
            
            // Check if cameras are available but don't request permission yet
            const devices = await navigator.mediaDevices.enumerateDevices();
            const videoDevices = devices.filter(device => device.kind === 'videoinput');
            
            if (videoDevices.length > 0) {
                // Camera available but don't access it until user clicks capture
                this.setStatus('Camera available - click capture to start', false);
                this.captureBtn.disabled = false;
            } else {
                console.log('No cameras found, enabling screen capture mode');
                // No cameras found, enable screen capture mode
                this.enableScreenCaptureMode();
            }

        } catch (error) {
            console.log('Camera enumeration failed, enabling screen capture mode:', error);
            // If camera enumeration fails, enable screen capture mode
            this.enableScreenCaptureMode();
        }
    }

    private enableScreenCaptureMode() {
        // Check what media APIs are available
        console.log('MediaDevices available:', !!navigator.mediaDevices);
        console.log('getUserMedia available:', !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia));
        console.log('getDisplayMedia available:', !!(navigator.mediaDevices && (navigator.mediaDevices as any).getDisplayMedia));
        console.log('WebRTC APIs available:', !!window.RTCPeerConnection);
        
        this.setStatus('Screen capture mode', true);
        this.captureBtn.disabled = false;
        
        // Hide camera selector and show change source button
        this.cameraSelect.style.display = 'none';
        this.changeSourceBtn.style.display = 'flex';
        
        // Update UI to indicate screen capture mode
        const captureBtn = this.captureBtn;
        captureBtn.innerHTML = `
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
                <line x1="8" y1="21" x2="16" y2="21"/>
                <line x1="12" y1="17" x2="12" y2="21"/>
            </svg>
            Take Screenshot
        `;
        
        if (navigator.mediaDevices && (navigator.mediaDevices as any).getDisplayMedia) {
            this.showStatus('No camera found. Click "Take Screenshot" to capture your screen instead!', 'info');
            
            console.log('getDisplayMedia is available - ready for screen capture');
        } else {
            this.showStatus('Screen capture not supported in this WebKit version.', 'error');
            this.captureBtn.disabled = true;
        }
    }

    private async tryCamera() {
        // Request camera permission and start stream
        const constraints: MediaStreamConstraints = {
            video: {
                width: { ideal: 1280 },
                height: { ideal: 720 }
                // Removed facingMode constraint as it's not supported on most desktop cameras
            },
            audio: false
        };

        this.stream = await navigator.mediaDevices.getUserMedia(constraints);
        this.video.srcObject = this.stream;

        // Update status
        this.setStatus('Camera active', true);
        this.captureBtn.disabled = false;

        // Update camera list with active camera
        const videoTrack = this.stream.getVideoTracks()[0];
        const settings = videoTrack.getSettings();
        if (settings.deviceId) {
            this.cameraSelect.value = settings.deviceId;
        }
    }

    private async tryScreenCapture() {
        console.log('tryScreenCapture called');
        
        // Stop existing stream if any
        if (this.stream) {
            console.log('Stopping existing stream');
            this.stream.getTracks().forEach(track => track.stop());
        }

        // Check if getDisplayMedia is available
        if (!navigator.mediaDevices || !(navigator.mediaDevices as any).getDisplayMedia) {
            throw new Error('getDisplayMedia not supported in this browser');
        }

        console.log('Requesting display media...');
        // Request screen capture (requires user gesture)
        this.stream = await (navigator.mediaDevices as any).getDisplayMedia({
            video: true,
            audio: false
        });
        
        console.log('Display media obtained:', this.stream);
        
        this.video.srcObject = this.stream;

        // Wait for video to be ready
        await new Promise<void>((resolve) => {
            const onLoadedData = () => {
                this.video.removeEventListener('loadeddata', onLoadedData);
                resolve();
            };
            
            if (this.video.readyState >= 2) {
                // Video is already loaded
                resolve();
            } else {
                this.video.addEventListener('loadeddata', onLoadedData);
            }
        });

        // Update status to indicate screen capture
        this.setStatus('Screen capture active', true);
        this.captureBtn.disabled = false;

        // Hide camera selector and show change source button
        this.cameraSelect.style.display = 'none';
        this.changeSourceBtn.style.display = 'flex';

        // Listen for when the user stops sharing (e.g., closes the share dialog)
        this.stream.getVideoTracks()[0].addEventListener('ended', () => {
            this.setStatus('Screen sharing stopped', false, true);
            this.showStatus('Screen sharing was stopped. Click "Change Source" to select a new source.', 'info');
        });
    }

    private async changeScreenSource() {
        console.log('Change source button clicked');
        try {
            console.log('Attempting screen capture...');
            // Always try screen capture when user explicitly asks to change source
            await this.tryScreenCapture();
            console.log('Screen capture successful');
            this.showStatus('Screen source changed successfully!', 'success');
        } catch (error) {
            console.error('Failed to change screen source:', error);
            this.showStatus(`Screen capture failed: ${error.message}`, 'error');
        }
    }

    private async getAvailableCameras() {
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

            // Show/hide camera selector based on available cameras
            this.cameraSelect.style.display = videoDevices.length > 1 ? 'block' : 'none';

        } catch (error) {
            console.error('Error enumerating devices:', error);
        }
    }

    private async switchCamera(deviceId: string) {
        try {
            // Stop current stream
            if (this.stream) {
                this.stream.getTracks().forEach(track => track.stop());
            }

            // Start new stream with selected camera
            const constraints: MediaStreamConstraints = {
                video: {
                    deviceId: { exact: deviceId },
                    width: { ideal: 1280 },
                    height: { ideal: 720 }
                },
                audio: false
            };

            this.stream = await navigator.mediaDevices.getUserMedia(constraints);
            this.video.srcObject = this.stream;

            // Wait for video to be ready after switching
            await new Promise<void>((resolve) => {
                const onLoadedData = () => {
                    this.video.removeEventListener('loadeddata', onLoadedData);
                    resolve();
                };
                
                if (this.video.readyState >= 2) {
                    // Video is already loaded
                    resolve();
                } else {
                    this.video.addEventListener('loadeddata', onLoadedData);
                }
            });

            this.setStatus('Camera switched', true);
            this.showStatus('Camera switched successfully!', 'success');

        } catch (error) {
            console.error('Error switching camera:', error);
            this.showStatus('Failed to switch camera', 'error');
        }
    }

    private async capturePhoto() {
        console.log('capturePhoto called, stream exists:', !!this.stream);
        
        // If no stream is available, try to get one (camera or screen capture)
        if (!this.stream) {
            console.log('No stream available, trying to get one...');
            try {
                // Check if cameras are available first
                const devices = await navigator.mediaDevices.enumerateDevices();
                const videoDevices = devices.filter(device => device.kind === 'videoinput');
                
                if (videoDevices.length > 0) {
                    // Try camera first
                    console.log('Cameras available, trying camera...');
                    await this.tryCamera();
                } else {
                    // No cameras, try screen capture
                    console.log('No cameras available, trying screen capture...');
                    await this.tryScreenCapture();
                }
                console.log('Stream obtained successfully');
            } catch (error) {
                console.error('Failed to get stream in capturePhoto:', error);
                this.showStatus(`Failed to get camera/screen: ${error.message}`, 'error');
                return;
            }
        }

        if (this.timerToggle.checked) {
            // Use timer
            this.captureBtn.disabled = true;
            await this.runCountdown();
            this.takePhoto();
            this.captureBtn.disabled = false;
        } else {
            // Immediate capture
            this.takePhoto();
        }
    }

    private async runCountdown() {
        for (let i = 3; i > 0; i--) {
            this.countdown.textContent = i.toString();
            this.countdown.classList.add('active');
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        this.countdown.classList.remove('active');
    }

    private takePhoto() {
        console.log('Taking photo - video dimensions:', this.video.videoWidth, 'x', this.video.videoHeight);
        console.log('Video readyState:', this.video.readyState);
        console.log('Stream state:', this.stream ? 'exists' : 'null');
        
        // Check if video is ready - give it more time if needed
        if (!this.video.videoWidth || !this.video.videoHeight) {
            // Try waiting a bit more for the video to load
            setTimeout(() => {
                if (this.video.videoWidth && this.video.videoHeight) {
                    console.log('Video ready after timeout, retrying...');
                    this.takePhoto();
                } else {
                    this.showStatus(`Video not ready (${this.video.videoWidth}x${this.video.videoHeight}). Please try "Change Source".`, 'error');
                }
            }, 1000);
            return;
        }

        // Check if stream is still active
        if (!this.stream || this.stream.getVideoTracks().length === 0) {
            this.showStatus('Stream not active. Please change source and try again.', 'error');
            return;
        }
        
        const videoTrack = this.stream.getVideoTracks()[0];
        if (!videoTrack || videoTrack.readyState !== 'live') {
            this.showStatus('Video track not live. Please change source and try again.', 'error');
            return;
        }

        // Set canvas size to match video
        this.canvas.width = this.video.videoWidth;
        this.canvas.height = this.video.videoHeight;

        // Draw video frame to canvas
        const ctx = this.canvas.getContext('2d');
        if (!ctx) {
            this.showStatus('Canvas not available', 'error');
            return;
        }

        ctx.drawImage(this.video, 0, 0);

        // Convert to data URL
        const dataUrl = this.canvas.toDataURL('image/png');

        // Verify we got valid image data
        if (dataUrl === 'data:,' || dataUrl.length < 100) {
            this.showStatus('Failed to capture image data. Please try again.', 'error');
            return;
        }

        // Create photo object
        const photo: Photo = {
            id: Date.now().toString(),
            dataUrl: dataUrl,
            timestamp: new Date()
        };

        // Add to photos array
        this.photos.unshift(photo);

        // Update gallery
        this.updateGallery();

        // Flash effect
        this.flashEffect();

        // Show success message
        this.showStatus('Screenshot captured!', 'success');
    }

    private flashEffect() {
        const flash = document.createElement('div');
        flash.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: white;
            opacity: 0.8;
            z-index: 999;
            pointer-events: none;
        `;
        document.body.appendChild(flash);

        setTimeout(() => {
            flash.style.transition = 'opacity 0.3s';
            flash.style.opacity = '0';
            setTimeout(() => flash.remove(), 300);
        }, 100);
    }

    private updateGallery() {
        if (this.photos.length === 0) {
            this.gallery.innerHTML = '<div class="empty-state">No photos/screenshots yet. Click the capture button to get started!</div>';
            return;
        }

        this.gallery.innerHTML = this.photos.map(photo => `
            <div class="photo-item" data-id="${photo.id}">
                <img src="${photo.dataUrl}" alt="Photo ${photo.id}">
                <div class="photo-time">${this.formatTime(photo.timestamp)}</div>
            </div>
        `).join('');

        // Add click listeners to photos
        this.gallery.querySelectorAll('.photo-item').forEach(item => {
            item.addEventListener('click', () => {
                const id = item.getAttribute('data-id');
                if (id) this.openModal(id);
            });
        });
    }

    private formatTime(date: Date): string {
        return date.toLocaleTimeString('en-US', { 
            hour: '2-digit', 
            minute: '2-digit' 
        });
    }

    private openModal(photoId: string) {
        const photo = this.photos.find(p => p.id === photoId);
        if (!photo) return;

        this.currentPhotoId = photoId;
        this.modalImage.src = photo.dataUrl;
        this.modal.classList.add('active');
    }

    private closeModal() {
        this.modal.classList.remove('active');
        this.currentPhotoId = null;
    }

    private async saveCurrentPhoto() {
        if (!this.currentPhotoId) return;

        const photo = this.photos.find(p => p.id === this.currentPhotoId);
        if (!photo) return;

        // Generate filename with timestamp
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `photo-booth-${timestamp}.png`;

        try {
            // Call RPC method to save photo
            if (electrobun.rpc) {
                const result = await electrobun.rpc.request.savePhoto({
                    dataUrl: photo.dataUrl,
                    filename: filename
                });

                if (result.success) {
                    this.showStatus(`Photo saved to ${result.path}`, 'success');
                } else if (result.reason === 'canceled') {
                    this.showStatus('Save canceled', 'info');
                } else {
                    this.showStatus(`Failed to save photo: ${result.error}`, 'error');
                }
            } else {
                this.showStatus('RPC not available', 'error');
            }
        } catch (error) {
            console.error('Error calling savePhoto RPC:', error);
            this.showStatus('Failed to save photo', 'error');
        }
    }

    private deleteCurrentPhoto() {
        if (!this.currentPhotoId) return;

        // Remove from photos array
        this.photos = this.photos.filter(p => p.id !== this.currentPhotoId);

        // Update gallery
        this.updateGallery();

        // Close modal
        this.closeModal();

        this.showStatus('Photo deleted', 'info');
    }

    private setStatus(text: string, active: boolean, error: boolean = false) {
        this.statusText.textContent = text;
        this.status.classList.toggle('active', active && !error);
        this.status.classList.toggle('error', error);
    }

    private showStatus(message: string, type: 'success' | 'error' | 'info') {
        // You could implement a toast notification here
        console.log(`[${type}] ${message}`);
        
        // Update status bar temporarily
        const originalText = this.statusText.textContent;
        const originalClasses = this.status.className;
        
        this.statusText.textContent = message;
        this.status.className = 'status ' + type;
        
        setTimeout(() => {
            this.statusText.textContent = originalText;
            this.status.className = originalClasses;
        }, 3000);
    }
}

// Initialize app when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => new PhotoBooth());
} else {
    new PhotoBooth();
}