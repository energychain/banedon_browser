#!/bin/bash

# Remote status check script for Browser Automation Service
# Checks the status of the service running on 10.0.0.2

set -e

# Configuration
SERVER_IP="10.0.0.2"
SERVER_USER="${1:-root}"
DEPLOY_PATH="/opt/banedon_browser"

echo "🔍 Remote Status Check for Browser Automation Service"
echo "===================================================="
echo "Target Server: $SERVER_USER@$SERVER_IP"
echo "Deploy Path: $DEPLOY_PATH"
echo ""

# Check SSH connectivity
echo "🌐 Testing SSH connectivity..."
if ! ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 "$SERVER_USER@$SERVER_IP" "echo 'SSH connection successful'" 2>/dev/null; then
    echo "❌ Cannot connect to $SERVER_USER@$SERVER_IP"
    echo "Usage: $0 [username]"
    exit 1
fi
echo "✅ SSH connection successful"

# Execute remote status checks
echo "🔍 Checking remote service status..."
ssh -o StrictHostKeyChecking=no "$SERVER_USER@$SERVER_IP" << EOF
set -e

if [ ! -d "$DEPLOY_PATH" ]; then
    echo "❌ Deployment directory not found: $DEPLOY_PATH"
    exit 1
fi

cd $DEPLOY_PATH

echo "📂 Repository Status:"
if [ -d ".git" ]; then
    echo "  Branch: \$(git branch --show-current 2>/dev/null || echo 'Unknown')"
    echo "  Commit: \$(git rev-parse --short HEAD 2>/dev/null || echo 'Unknown')"
    echo "  Last update: \$(git log -1 --format='%cd' --date=local 2>/dev/null || echo 'Unknown')"
else
    echo "  ❌ Not a git repository"
fi

echo ""
echo "🐳 Docker Status:"
if command -v docker &> /dev/null; then
    if docker info >/dev/null 2>&1; then
        echo "  ✅ Docker is running"
        
        if [ -f "docker-compose.yml" ]; then
            echo ""
            echo "📊 Container Status:"
            docker-compose -f docker-compose.yml ps
            
            echo ""
            echo "📈 Resource Usage:"
            docker stats --no-stream --format "table {{.Container}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}\t{{.BlockIO}}" 2>/dev/null || echo "  Could not retrieve stats"
        else
            echo "  ❌ docker-compose.yml not found"
        fi
    else
        echo "  ❌ Docker is not running"
    fi
else
    echo "  ❌ Docker is not installed"
fi

echo ""
echo "🏥 Service Health Check:"
if curl -f http://localhost:3010/health >/dev/null 2>&1; then
    echo "  ✅ Service is healthy"
    echo "  Response: \$(curl -s http://localhost:3010/health 2>/dev/null || echo 'Could not fetch')"
else
    echo "  ❌ Service health check failed"
fi

echo ""
echo "🌐 Network Connectivity:"
if netstat -tlnp 2>/dev/null | grep :3010 >/dev/null; then
    echo "  ✅ Port 3010 is listening"
else
    echo "  ❌ Port 3010 is not listening"
fi

echo ""
echo "📋 Recent Logs (last 10 lines):"
if [ -f "docker-compose.yml" ]; then
    docker-compose -f docker-compose.yml logs --tail=10 browser-automation-service 2>/dev/null || echo "  Could not retrieve logs"
else
    echo "  ❌ docker-compose.yml not found"
fi

echo ""
echo "💾 Disk Usage:"
echo "  Deploy directory: \$(du -sh $DEPLOY_PATH 2>/dev/null || echo 'Unknown')"
echo "  Available space: \$(df -h $DEPLOY_PATH | tail -1 | awk '{print \$4}' 2>/dev/null || echo 'Unknown')"
EOF

echo ""
echo "🧪 External Connectivity Test:"
echo "Testing service from external perspective..."

# Test health endpoint from external
if curl -f --connect-timeout 10 "http://$SERVER_IP:3010/health" >/dev/null 2>&1; then
    echo "✅ External health check successful"
    echo "Response: $(curl -s "http://$SERVER_IP:3010/health" 2>/dev/null)"
else
    echo "❌ External health check failed"
    echo "   - Check if port 3010 is open in firewall"
    echo "   - Verify service is running and bound to 0.0.0.0:3010"
fi

echo ""
echo "🔗 Service URLs:"
echo "  Internal: http://localhost:3010"
echo "  External: http://$SERVER_IP:3010"
echo "  Health: http://$SERVER_IP:3010/health"
echo ""
echo "🛠 Management commands (run on server):"
echo "  ssh $SERVER_USER@$SERVER_IP 'cd $DEPLOY_PATH && docker-compose -f docker-compose.yml logs'"
echo "  ssh $SERVER_USER@$SERVER_IP 'cd $DEPLOY_PATH && docker-compose -f docker-compose.yml restart'"
echo "  ssh $SERVER_USER@$SERVER_IP 'cd $DEPLOY_PATH && docker-compose -f docker-compose.yml down'"
