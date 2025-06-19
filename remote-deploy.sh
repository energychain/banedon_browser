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

# Step 1: Handle git operations automatically
echo "� Handling git operations..."

# Check for uncommitted changes and auto-commit if any
if ! git diff-index --quiet HEAD --; then
    echo "📝 Found uncommitted changes, staging and committing..."
    git add .
    
    # Generate a commit message based on changed files
    CHANGED_FILES=$(git diff --cached --name-only | head -5 | tr '\n' ' ')
    COMMIT_MSG="Auto-commit before deployment: Updated ${CHANGED_FILES}"
    
    git commit -m "$COMMIT_MSG"
    echo "✅ Changes committed: $COMMIT_MSG"
else
    echo "✅ No uncommitted changes found"
fi

# Step 2: Push changes to remote
echo "📤 Pushing changes to remote repository..."
CURRENT_BRANCH=$(git branch --show-current)
git push origin "$CURRENT_BRANCH"
echo "✅ Changes pushed to origin/$CURRENT_BRANCH"

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
cd $DEPLOY_PATH

# Use docker compose or docker-compose depending on what's available
if docker compose version >/dev/null 2>&1; then
    DOCKER_COMPOSE_CMD="docker compose"
else
    DOCKER_COMPOSE_CMD="docker-compose"
fi

# Stop existing services if docker-compose.yml exists
if [ -f "docker-compose.yml" ]; then
    \$DOCKER_COMPOSE_CMD -f docker-compose.yml down 2>/dev/null || true
else
    echo "⚠️  No docker-compose.yml found yet"
fi

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

# Build extension package locally (will be included in Docker build)
if [ -f "build.sh" ]; then
    echo "🔨 Building extension package for Docker..."
    ./build.sh 2>/dev/null || echo "⚠️  Extension build failed, will be built in Docker"
fi

# Build and start services
echo "🚀 Building and starting services..."
cd $DEPLOY_PATH

# Verify we're in the right directory and have the compose file
if [ ! -f "docker-compose.yml" ]; then
    echo "❌ Error: docker-compose.yml not found in $DEPLOY_PATH"
    exit 1
fi

echo "✅ Found docker-compose.yml in \$(pwd)"

# Use docker compose or docker-compose depending on what's available
if docker compose version >/dev/null 2>&1; then
    DOCKER_COMPOSE_CMD="docker compose"
else
    DOCKER_COMPOSE_CMD="docker-compose"
fi

echo "🐳 Using: \$DOCKER_COMPOSE_CMD"

# Build and start the service
\$DOCKER_COMPOSE_CMD -f docker-compose.yml up -d --build

# Wait a moment for services to start
sleep 5

# Check service health
echo "🏥 Checking service health..."
cd $DEPLOY_PATH
\$DOCKER_COMPOSE_CMD -f docker-compose.yml ps

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
    \$DOCKER_COMPOSE_CMD -f docker-compose.yml ps
else
    echo ""
    echo "❌ Deployment completed but service health check failed"
    echo "📋 Check logs:"
    echo "   \$DOCKER_COMPOSE_CMD -f docker-compose.yml logs browser-automation-service"
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

# Step 3: Run local tests against deployed service
echo "🧪 Running local tests against deployed service..."
echo "=================================================="

# Set test environment to point to remote server
export TEST_SERVER_URL="http://$SERVER_IP:3010"
export NODE_ENV=test

# Wait a bit more for the service to fully stabilize
echo "⏳ Waiting for service to stabilize..."
sleep 10

# Run the specific flight search test
echo "� Running flight search test..."
if npm test -- --testNamePattern="flight search" --testTimeout=90000; then
    echo "✅ Flight search test passed! The automation system is working correctly."
else
    echo "❌ Flight search test failed. The deployed system may have issues."
    echo ""
    echo "�🔧 Troubleshooting steps:"
    echo "  1. Check service logs: ssh $SERVER_USER@$SERVER_IP 'cd $DEPLOY_PATH && docker-compose logs'"
    echo "  2. Verify service health: curl http://$SERVER_IP:3010/health"
    echo "  3. Check browser extension is working"
    echo ""
    exit 1
fi

echo ""
echo "🔧 Management Commands (run on server):"
echo "  cd $DEPLOY_PATH"
echo "  \$DOCKER_COMPOSE_CMD -f docker-compose.yml ps          # Check status"
echo "  \$DOCKER_COMPOSE_CMD -f docker-compose.yml logs        # View logs"
echo "  \$DOCKER_COMPOSE_CMD -f docker-compose.yml restart     # Restart service"
echo "  \$DOCKER_COMPOSE_CMD -f docker-compose.yml down        # Stop service"
echo ""
echo "🧪 Manual test commands:"
echo "  curl http://$SERVER_IP:3010/health"
echo "  npm test -- --testNamePattern=\"flight search\" # Run against deployed service"
