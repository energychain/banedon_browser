#!/bin/sh

# Cleanup script for Browser Automation Service
# Removes temporary files and ensures clean repository state

echo "🧹 Cleaning up Browser Automation Service repository..."

# Remove node_modules if present (should be in .gitignore)
if [ -d "node_modules" ]; then
    echo "🗑️  Removing node_modules directory..."
    rm -rf node_modules
fi

# Remove any log files
echo "🗑️  Cleaning log files..."
rm -f *.log
rm -f logs/*.log 2>/dev/null || true

# Remove any temporary build artifacts
echo "🗑️  Cleaning temporary build files..."
rm -f *.tmp
rm -f .*.tmp

# Remove any editor backup files
echo "🗑️  Removing editor backup files..."
rm -f *~
rm -f .*~
rm -f .#*
rm -f \#*\#

# Remove any OS-specific files
echo "🗑️  Removing OS-specific files..."
rm -f .DS_Store
rm -f Thumbs.db
rm -f desktop.ini

# Clean Docker volumes and containers (optional)
echo "🐳 Docker cleanup (containers and volumes)..."
docker system prune -f 2>/dev/null || echo "Docker not available or no cleanup needed"

# Verify build directory structure
if [ -d "build" ]; then
    echo "✅ Build directory exists"
    if [ -f "build/browser-automation-extension.zip" ]; then
        echo "✅ Extension package exists: $(du -h build/browser-automation-extension.zip | cut -f1)"
    else
        echo "⚠️  Extension package not found - run ./build.sh to create it"
    fi
else
    echo "⚠️  Build directory not found - run ./build.sh to create extension package"
fi

# Verify key files exist
echo "🔍 Verifying key files..."
key_files="
    package.json
    docker-compose.yml
    Dockerfile
    src/server.js
    extension/manifest.json
    public/index.html
    PHASE1_COMPLETE_FINAL.md
    README.md
"

for file in $key_files; do
    if [ -f "$file" ]; then
        echo "✅ $file"
    else
        echo "❌ Missing: $file"
    fi
done

# Check git status
if [ -d ".git" ]; then
    echo ""
    echo "📊 Git repository status:"
    git status --porcelain
    if [ $? -eq 0 ]; then
        if [ -z "$(git status --porcelain)" ]; then
            echo "✅ Repository is clean"
        else
            echo "⚠️  Repository has uncommitted changes"
        fi
    fi
fi

echo ""
echo "✅ Cleanup complete!"
echo ""
echo "🚀 Ready for Phase 2 handoff:"
echo "   • All key files verified"
echo "   • Temporary files cleaned"
echo "   • Build artifacts in place"
echo "   • Repository ready for integration"
