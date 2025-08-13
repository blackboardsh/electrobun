# Photo Booth Template

A cross-platform desktop photo booth application built with Electrobun. This template demonstrates how to use the getUserMedia API to access the user's camera, capture photos, and save them to disk.

## Features

- **Camera Access**: Uses getUserMedia to access and display live camera feed
- **Photo Capture**: Take instant photos or use a 3-second timer
- **Camera Selection**: Switch between multiple cameras if available
- **Photo Gallery**: View all captured photos in a grid layout
- **Full-Screen Preview**: Click any photo to view it in full size
- **Save to Disk**: Save photos to your computer with a native file dialog
- **Delete Photos**: Remove unwanted photos from the gallery
- **Modern UI**: Clean, responsive interface with dark theme

## Project Structure

```
src/
├── bun/
│   └── index.ts      # Main process - handles window creation and file operations
└── mainview/
    ├── index.html    # Photo booth UI structure
    ├── index.css     # Styling
    └── index.ts      # Camera logic and photo management
```

## Getting Started

### Development Mode
```bash
bun dev
```

### Build for Production
```bash
bun build
```

### Run the Built App
```bash
bun start
```

## How It Works

### Camera Access
The app requests camera permission on startup using the Web MediaDevices API:
```typescript
const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false
});
```

### Photo Capture
Photos are captured by drawing the current video frame to a canvas:
1. Video stream is displayed in a `<video>` element
2. When capture is triggered, the current frame is drawn to a hidden `<canvas>`
3. Canvas is converted to a data URL (base64 PNG)
4. Photo is stored in memory and displayed in the gallery

### File Saving
The save functionality uses Electrobun's IPC to communicate between renderer and main process:
1. Renderer sends the photo data URL to main process
2. Main process shows a native save dialog
3. If user confirms, the base64 data is converted to a buffer and written to disk

## Customization

### Styling
Modify `src/mainview/index.css` to customize the appearance. The app uses CSS variables for easy theming.

### Camera Settings
Adjust camera constraints in `index.ts` to change resolution or other parameters:
```typescript
const constraints = {
    video: {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        facingMode: 'user' // or 'environment' for rear camera
    }
};
```

### Storage
Currently photos are stored in memory. You could extend this to:
- Save photos automatically to a specific folder
- Store photo metadata in a database
- Upload photos to a cloud service

## Security Considerations

- Camera permissions are requested explicitly
- Photos are only saved when user confirms via native dialog
- No network requests are made
- All photo data stays local to the device

## Browser Compatibility

This template uses modern web APIs that require:
- Secure context (HTTPS or localhost)
- Modern browser with getUserMedia support
- Camera/webcam hardware

## License

This template is part of the Electrobun project and follows the same license terms.