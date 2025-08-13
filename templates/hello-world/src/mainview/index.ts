// Simple Hello World - no RPC needed for this basic template
console.log("Hello Electrobun view loaded!");

// Test camera permission dialog
document.getElementById('testCameraBtn')?.addEventListener('click', async () => {
    console.log('Testing camera permission...');
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
            video: true, 
            audio: false 
        });
        console.log('Camera permission granted:', stream);
        alert('Camera permission granted! Check console for stream details.');
        
        // Stop the stream immediately since we're just testing
        stream.getTracks().forEach(track => track.stop());
    } catch (error) {
        console.error('Camera permission denied or failed:', error);
        alert(`Camera permission failed: ${error.message}`);
    }
});

// You can add interactive functionality here
// For RPC communication with the Bun process, check out the playground example