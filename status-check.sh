#!/bin/bash

# Status check script for Browser Automation Service
# Usage: ./status-check.sh [server_ip]

SERVER_IP=${1:-"10.0.0.2"}
PORT=${2:-"3010"}

echo "🔍 Checking Browser Automation Service status on $SERVER_IP:$PORT"
echo "=================================================="

# Function to check HTTP endpoint
check_endpoint() {
    local url=$1
    local description=$2
    
    echo -n "Testing $description... "
    
    if curl -s --max-time 10 "$url" > /dev/null; then
        echo "✅ OK"
        return 0
    else
        echo "❌ FAILED"
        return 1
    fi
}

# Function to check HTTP endpoint with response
check_endpoint_response() {
    local url=$1
    local description=$2
    
    echo "Testing $description:"
    echo -n "  URL: $url ... "
    
    local response=$(curl -s --max-time 10 "$url" 2>/dev/null)
    
    if [ $? -eq 0 ] && [ -n "$response" ]; then
        echo "✅ OK"
        echo "  Response: $response"
        return 0
    else
        echo "❌ FAILED"
        return 1
    fi
}

# Test basic connectivity
echo "1. Network Connectivity"
if ping -c 1 -W 3 "$SERVER_IP" > /dev/null 2>&1; then
    echo "   ✅ Server $SERVER_IP is reachable"
else
    echo "   ❌ Server $SERVER_IP is not reachable"
    exit 1
fi

echo ""

# Test Docker status (if we can SSH or are running locally)
echo "2. Docker Container Status"
if command -v docker-compose &> /dev/null && [ -f "docker-compose.yml" ]; then
    echo "   Docker Compose services:"
    docker-compose ps 2>/dev/null || echo "   ⚠️  Cannot check Docker Compose status (not running locally or no access)"
else
    echo "   ⚠️  Cannot check Docker status (not running locally)"
fi

echo ""

# Test service endpoints
echo "3. Service Endpoints"
BASE_URL="http://$SERVER_IP:$PORT"

check_endpoint_response "$BASE_URL/health" "Health check"
echo ""

# Test API endpoints
echo "4. API Endpoints"
check_endpoint "$BASE_URL/api/sessions" "Sessions API (GET)"

# Try to create a test session
echo -n "Testing session creation... "
SESSION_RESPONSE=$(curl -s --max-time 10 -X POST "$BASE_URL/api/sessions" \
    -H "Content-Type: application/json" \
    -d '{"metadata":{"browser":"chrome","purpose":"status-check"}}' 2>/dev/null)

if [ $? -eq 0 ] && echo "$SESSION_RESPONSE" | grep -q '"id"'; then
    echo "✅ OK"
    SESSION_ID=$(echo "$SESSION_RESPONSE" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
    echo "  Created session: $SESSION_ID"
    
    # Clean up the test session
    if [ -n "$SESSION_ID" ]; then
        echo -n "Cleaning up test session... "
        if curl -s --max-time 10 -X DELETE "$BASE_URL/api/sessions/$SESSION_ID" > /dev/null 2>&1; then
            echo "✅ OK"
        else
            echo "⚠️  Could not delete test session"
        fi
    fi
else
    echo "❌ FAILED"
fi

echo ""

# Test WebSocket connectivity (basic check)
echo "5. WebSocket Connectivity"
echo -n "Testing WebSocket endpoint... "
if command -v curl &> /dev/null; then
    # Try to upgrade to WebSocket (will fail but shows if endpoint exists)
    WS_RESPONSE=$(curl -s --max-time 5 -H "Upgrade: websocket" -H "Connection: Upgrade" "$BASE_URL/ws" 2>/dev/null)
    if [ $? -eq 0 ]; then
        echo "✅ WebSocket endpoint reachable"
    else
        echo "❌ WebSocket endpoint not reachable"
    fi
else
    echo "⚠️  Cannot test WebSocket (curl not available)"
fi

echo ""

# Port accessibility check
echo "6. Port Accessibility"
echo -n "Testing port $PORT accessibility... "
if command -v nc &> /dev/null; then
    if nc -z -w3 "$SERVER_IP" "$PORT" 2>/dev/null; then
        echo "✅ Port $PORT is open"
    else
        echo "❌ Port $PORT is not accessible"
    fi
elif command -v telnet &> /dev/null; then
    if timeout 3 telnet "$SERVER_IP" "$PORT" </dev/null 2>/dev/null | grep -q "Connected"; then
        echo "✅ Port $PORT is open"
    else
        echo "❌ Port $PORT is not accessible"
    fi
else
    echo "⚠️  Cannot test port (nc/telnet not available)"
fi

echo ""
echo "=================================================="
echo "🎯 Status Check Complete"
echo ""
echo "🔗 Service URLs:"
echo "   Health:    $BASE_URL/health"
echo "   API Base:  $BASE_URL/api"
echo "   WebSocket: ws://$SERVER_IP:$PORT/ws"
echo ""
echo "📱 Browser Extension Configuration:"
echo "   Server URL: $BASE_URL"
echo ""
echo "🛠  Troubleshooting:"
echo "   - Check Docker: docker-compose ps"
echo "   - View logs: docker-compose logs browser-automation-service"
echo "   - Check firewall: ensure port $PORT is open"
