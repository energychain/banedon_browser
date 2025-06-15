#!/bin/bash

# Quick deployment script for Browser Automation Service
# Usage: ./deploy.sh [server_ip]

set -e

SERVER_IP=${1:-"10.0.0.2"}
echo "🚀 Deploying Browser Automation Service for server: $SERVER_IP"

# Check if we're in the right directory
if [ ! -f "package.json" ] || [ ! -f "docker-compose.yml" ]; then
    echo "❌ Error: Run this script from the project root directory"
    exit 1
fi

# Check if Docker is available
if ! command -v docker &> /dev/null; then
    echo "❌ Error: Docker is not installed or not in PATH"
    exit 1
fi

if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
    echo "❌ Error: Docker Compose is not installed or not in PATH"
    exit 1
fi

echo "📋 Setting up production environment..."

# Create production environment file if it doesn't exist
if [ ! -f ".env.production" ]; then
    echo "📝 Creating .env.production from template..."
    cp .env.production.example .env.production
    
    # Update server IP in the production environment
    sed -i "s/10\.0\.0\.2/$SERVER_IP/g" .env.production
    echo "✅ Updated ALLOWED_ORIGINS for server IP: $SERVER_IP"
    echo "⚠️  Please review .env.production for any additional configuration needed"
fi

# Create logs directory
mkdir -p logs

echo "🐳 Building and starting Docker containers..."

# Stop existing containers
docker-compose down 2>/dev/null || true

# Build and start the service
docker-compose up -d browser-automation-service

# Wait a moment for the service to start
echo "⏳ Waiting for service to start..."
sleep 10

# Check if service is healthy
echo "🔍 Checking service health..."
if curl -s "http://localhost:3010/health" > /dev/null; then
    echo "✅ Service is running and healthy!"
    echo ""
    echo "🌐 Service URLs:"
    echo "   Health check: http://$SERVER_IP:3010/health"
    echo "   API base:     http://$SERVER_IP:3010/api"
    echo "   WebSocket:    ws://$SERVER_IP:3010/ws"
    echo ""
    echo "📱 Browser Extension Configuration:"
    echo "   Server URL: http://$SERVER_IP:3010"
    echo ""
    echo "🔧 Next steps:"
    echo "   1. Test the health endpoint: curl http://$SERVER_IP:3010/health"
    echo "   2. Build browser extension: ./build.sh"
    echo "   3. Configure firewall to allow port 3010"
    echo "   4. Distribute extension to users"
    echo ""
    echo "📊 Monitor with:"
    echo "   docker-compose ps"
    echo "   docker-compose logs browser-automation-service"
else
    echo "❌ Service health check failed!"
    echo "📋 Check logs:"
    echo "   docker-compose logs browser-automation-service"
    exit 1
fi

echo "🎉 Deployment completed successfully!"
