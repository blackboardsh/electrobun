#!/bin/bash

# Test npm installation locally
echo "Testing Electrobun npm installation..."

# Create a temporary test directory
TEST_DIR=$(mktemp -d)
cd $TEST_DIR

echo "Test directory: $TEST_DIR"

# Initialize a test project
npm init -y

# Set environment variable to use specific version
export ELECTROBUN_VERSION=v0.0.19-beta.1

# Install electrobun (will use local package.json)
npm install file:///home/yoav/code/electrobun

# Check if installation worked
if [ -f "node_modules/electrobun/dist/electrobun" ]; then
    echo "✓ Electrobun CLI installed successfully"
    ./node_modules/.bin/electrobun --version
else
    echo "✗ Electrobun CLI not found"
fi

# List installed files
echo -e "\nInstalled files:"
find node_modules/electrobun -type f -name "*.ts" | head -10
find node_modules/electrobun/dist -type f | head -10

echo -e "\nTest complete. Directory: $TEST_DIR"