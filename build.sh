#!/bin/sh

# Build script for Browser Automation Service Extension

echo "📦 Building Browser Automation Service Extension..."

# Create build directory
BUILD_DIR="build"
EXTENSION_BUILD_DIR="$BUILD_DIR/extension"

rm -rf "$BUILD_DIR"
mkdir -p "$EXTENSION_BUILD_DIR"

# Copy extension files
echo "📋 Copying extension files..."
cp -r extension/* "$EXTENSION_BUILD_DIR/"

# Create extension package
echo "🗜️  Creating extension package..."
cd "$EXTENSION_BUILD_DIR"
zip -r "../browser-automation-extension.zip" . -x "*.DS_Store" "*.git*"
cd ../..

echo "✅ Extension built successfully!"
echo "📁 Extension files: $EXTENSION_BUILD_DIR"
echo "📦 Extension package: $BUILD_DIR/browser-automation-extension.zip"

# Build service Docker image
echo "🐳 Building Docker image..."
docker build -t browser-automation-service:latest .

echo "🎉 Build complete!"
echo ""
echo "🚀 Quick start:"
echo "  1. Install extension from $EXTENSION_BUILD_DIR"
echo "  2. Run: docker run -p 3010:3010 browser-automation-service:latest"
echo "  3. Or run: npm start"
