// Transparent Window JavaScript
document.addEventListener('DOMContentLoaded', function() {
    console.log('Transparent window loaded');
    
    // Handle close button click
    const closeBtn = document.getElementById('closeBtn');
    if (closeBtn) {
        closeBtn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            console.log('Close button clicked');
            
            // Call the RPC method to close the window
            if (window.rpc && window.rpc.closeWindow) {
                window.rpc.closeWindow()
                    .then(() => console.log('Window close requested'))
                    .catch(err => console.error('Failed to close window:', err));
            } else {
                console.error('RPC closeWindow method not available');
            }
        });
        
        console.log('Close button event listener attached');
    } else {
        console.error('Close button not found');
    }
});