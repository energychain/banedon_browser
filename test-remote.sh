#!/bin/bash

# Test script for remote Browser Automation Service
# Tests the deployed service without redeploying

set -e

# Configuration
SERVER_IP="${1:-10.0.0.2}"
SERVER_URL="http://$SERVER_IP:3010"

echo "🧪 Testing Remote Browser Automation Service"
echo "============================================="
echo "Target Server: $SERVER_URL"
echo ""

# Check if server is reachable
echo "🔍 Checking server connectivity..."
if curl -f --connect-timeout 10 "$SERVER_URL/health" >/dev/null 2>&1; then
    echo "✅ Server is reachable and healthy"
else
    echo "❌ Server is not reachable or unhealthy"
    echo "Please check:"
    echo "  1. Server is running: ssh root@$SERVER_IP 'cd /opt/banedon_browser && docker-compose ps'"
    echo "  2. Service health: curl $SERVER_URL/health"
    exit 1
fi

# Set test environment
export TEST_SERVER_URL="$SERVER_URL"
export NODE_ENV=test

echo ""
echo "🛫 Running flight search test against remote server..."
echo "======================================================"

# Run the flight search test with extended timeout
if npm test -- --testNamePattern="flight search" --testTimeout=180000 --verbose; then
    echo ""
    echo "🎉 Remote testing completed successfully!"
    echo "✅ The flight search automation is working correctly on $SERVER_URL"
else
    echo ""
    echo "❌ Remote testing failed!"
    echo ""
    echo "🔧 Troubleshooting steps:"
    echo "  1. Check service logs: ssh root@$SERVER_IP 'cd /opt/banedon_browser && docker-compose logs'"
    echo "  2. Verify service health: curl $SERVER_URL/health"
    echo "  3. Check if browser extension is connected"
    echo "  4. Verify Gemini API key is configured"
    echo ""
    exit 1
fi

echo ""
echo "📊 Test Summary:"
echo "  Server: $SERVER_URL"
echo "  Status: ✅ All tests passed"
echo "  Flight Search: ✅ Working correctly"
echo ""
echo "🔗 Useful links:"
echo "  Health: $SERVER_URL/health"
echo "  API Docs: $SERVER_URL/api-docs.html"
echo "  Demo: $SERVER_URL/nl-demo.html"
