#!/bin/bash

# Remote deployment script for Browser Automation Service
# Deploys to server 10.0.0.2 in /opt/banedon_browser

set -e

# Configuration
SERVER_IP="10.0.0.2"
SERVER_USER="${1:-root}"  # Default to root, can be overridden
DEPLOY_PATH="/opt/banedon_browser"
REPO_URL="git@github.com:energychain/banedon_browser.git"
REPO_URL_HTTPS="https://github.com/energychain/banedon_browser.git"  # Fallback for HTTPS

echo "🚀 Remote Deployment Script for Browser Automation Service"
echo "========================================================="
echo "Target Server: $SERVER_USER@$SERVER_IP"
echo "Deploy Path: $DEPLOY_PATH"
echo "Repository: $REPO_URL"
echo ""

# Function to execute commands on remote server
remote_exec() {
    local cmd="$1"
    local description="$2"
    
    if [ -n "$description" ]; then
        echo "📋 $description"
    fi
    
    ssh -o StrictHostKeyChecking=no "$SERVER_USER@$SERVER_IP" "$cmd"
}

# Check if we're in a git repository
if [ ! -d ".git" ]; then
    echo "❌ Error: Not in a git repository"
    exit 1
fi

# Check for uncommitted changes
echo "🔍 Checking for uncommitted changes..."
if ! git diff-index --quiet HEAD --; then
    echo "❌ Error: You have uncommitted changes. Please commit them first:"
    git status --porcelain
    echo ""
    echo "Run: git add . && git commit -m 'Your commit message'"
    exit 1
fi

# Check if local branch is ahead of remote
echo "🔍 Checking if local changes are pushed..."
LOCAL_COMMIT=$(git rev-parse HEAD)
REMOTE_COMMIT=$(git rev-parse origin/$(git branch --show-current) 2>/dev/null || echo "")

if [ "$LOCAL_COMMIT" != "$REMOTE_COMMIT" ]; then
    echo "⚠️  Local branch is ahead of remote. Pushing changes..."
    git push origin $(git branch --show-current)
    echo "✅ Changes pushed to remote repository"
fi

# Check SSH connectivity
echo "🔍 Testing SSH connectivity to $SERVER_USER@$SERVER_IP..."
if ! ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 "$SERVER_USER@$SERVER_IP" "echo 'SSH connection successful'" 2>/dev/null; then
    echo "❌ Cannot connect to $SERVER_USER@$SERVER_IP"
    echo "Please ensure:"
    echo "  1. SSH access is configured"
    echo "  2. SSH keys are set up"
    echo "  3. Server is accessible"
    echo ""
    echo "Usage: $0 [username]"
    echo "Example: $0 ubuntu"
    exit 1
fi
echo "✅ SSH connection successful"

# Start remote deployment
echo "🚀 Starting remote deployment..."

# Deploy via SSH
ssh -o StrictHostKeyChecking=no "$SERVER_USER@$SERVER_IP" << EOF
set -e

echo "📦 Installing prerequisites..."
# Update package list
apt-get update -qq

# Install essential packages
apt-get install -y git curl wget software-properties-common

# Install Docker if not present
if ! command -v docker &> /dev/null; then
    echo "🐳 Installing Docker..."
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker
    systemctl start docker
    usermod -aG docker \$(whoami) 2>/dev/null || true
else
    echo "✅ Docker already installed"
fi

# Install Docker Compose if not present
if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null 2>&1; then
    echo "🐳 Installing Docker Compose..."
    COMPOSE_VERSION=\$(curl -s https://api.github.com/repos/docker/compose/releases/latest | grep 'tag_name' | cut -d\" -f4)
    curl -L "https://github.com/docker/compose/releases/download/\${COMPOSE_VERSION}/docker-compose-\$(uname -s)-\$(uname -m)" -o /usr/local/bin/docker-compose
    chmod +x /usr/local/bin/docker-compose
else
    echo "✅ Docker Compose already installed"
fi

# Create deployment directory
echo "📁 Setting up deployment directory..."
mkdir -p $DEPLOY_PATH
cd $DEPLOY_PATH

# Clone or update repository
if [ -d ".git" ]; then
    echo "🔄 Updating existing repository..."
    git fetch origin
    git reset --hard origin/main
    git clean -fd
else
    echo "📥 Cloning repository..."
    # Try SSH first, fallback to HTTPS
    if git clone $REPO_URL . 2>/dev/null; then
        echo "✅ Cloned via SSH"
    elif git clone $REPO_URL_HTTPS . 2>/dev/null; then
        echo "✅ Cloned via HTTPS"
    else
        echo "❌ Failed to clone repository"
        exit 1
    fi
fi

echo "✅ Repository ready at $DEPLOY_PATH"

# Stop existing services
echo "🛑 Stopping existing services..."
docker-compose down 2>/dev/null || true

# Create production environment file
echo "⚙️  Setting up production environment..."
if [ ! -f ".env.production" ]; then
    if [ -f ".env.production.example" ]; then
        cp .env.production.example .env.production
    elif [ -f ".env" ]; then
        cp .env .env.production
    else
        echo "❌ No environment template found"
        exit 1
    fi
fi

# Update server IP in environment
sed -i "s/localhost/$SERVER_IP/g" .env.production
sed -i "s/127\.0\.0\.1/$SERVER_IP/g" .env.production

# Ensure logs directory exists
mkdir -p logs

# Make scripts executable
chmod +x *.sh 2>/dev/null || true

# Build and start services
echo "🚀 Building and starting services..."
docker-compose up -d --build

# Wait a moment for services to start
sleep 5

# Check service health
echo "🏥 Checking service health..."
docker-compose ps

# Test health endpoint
echo "🧪 Testing health endpoint..."
for i in {1..10}; do
    if curl -f http://localhost:3010/health >/dev/null 2>&1; then
        echo "✅ Service is healthy!"
        break
    else
        echo "⏳ Waiting for service to be ready... (attempt \$i/10)"
        sleep 3
    fi
done

# Final status check
if curl -f http://localhost:3010/health >/dev/null 2>&1; then
    echo ""
    echo "🎉 Deployment successful!"
    echo "📍 Service URL: http://$SERVER_IP:3010"
    echo "🏥 Health check: http://$SERVER_IP:3010/health"
    echo ""
    echo "📊 Service status:"
    docker-compose ps
else
    echo ""
    echo "❌ Deployment completed but service health check failed"
    echo "📋 Check logs:"
    echo "   docker-compose logs browser-automation-service"
    exit 1
fi
EOF

echo ""
echo "🎉 Remote deployment completed successfully!"
echo ""
echo "📍 Service Information:"
echo "  Server: $SERVER_IP"
echo "  Path: $DEPLOY_PATH"
echo "  URL: http://$SERVER_IP:3010"
echo "  Health: http://$SERVER_IP:3010/health"
echo ""
echo "🔧 Management Commands (run on server):"
echo "  cd $DEPLOY_PATH"
echo "  docker-compose ps          # Check status"
echo "  docker-compose logs        # View logs"
echo "  docker-compose restart     # Restart service"
echo "  docker-compose down        # Stop service"
echo ""
echo "🧪 Test the deployment:"
echo "  curl http://$SERVER_IP:3010/health"
