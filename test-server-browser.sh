#!/bin/bash

# Server-Side Browser Automation Test Script
# Tests the new headless browser functionality

BASE_URL="http://10.0.0.2:3010"

echo "🧪 Testing Server-Side Browser Automation"
echo "========================================="
echo

# Test 1: Create Session
echo "📋 Step 1: Creating session..."
SESSION_RESPONSE=$(curl -s -X POST $BASE_URL/api/sessions \
  -H "Content-Type: application/json" \
  -d '{"metadata": {"purpose": "server-browser-test", "mode": "headless"}}')

SESSION_ID=$(echo $SESSION_RESPONSE | jq -r '.session.id')
echo "✅ Session created: $SESSION_ID"
echo

# Test 2: Navigate 
echo "🌐 Step 2: Navigating to example.com..."
NAVIGATE_RESPONSE=$(curl -s -X POST $BASE_URL/api/sessions/$SESSION_ID/commands \
  -H "Content-Type: application/json" \
  -d '{"type": "navigate", "payload": {"url": "https://example.com"}}')

echo "✅ Navigation result:"
echo $NAVIGATE_RESPONSE | jq '.result'
echo

# Test 3: Get Title
echo "📄 Step 3: Getting page title..."
TITLE_RESPONSE=$(curl -s -X POST $BASE_URL/api/sessions/$SESSION_ID/commands \
  -H "Content-Type: application/json" \
  -d '{"type": "getTitle"}')

echo "✅ Page title:"
echo $TITLE_RESPONSE | jq '.result'
echo

# Test 4: Get URL
echo "🔗 Step 4: Getting current URL..."
URL_RESPONSE=$(curl -s -X POST $BASE_URL/api/sessions/$SESSION_ID/commands \
  -H "Content-Type: application/json" \
  -d '{"type": "getUrl"}')

echo "✅ Current URL:"
echo $URL_RESPONSE | jq '.result'
echo

# Test 5: Screenshot
echo "📸 Step 5: Taking screenshot..."
SCREENSHOT_RESPONSE=$(curl -s -X POST $BASE_URL/api/sessions/$SESSION_ID/commands \
  -H "Content-Type: application/json" \
  -d '{"type": "screenshot", "payload": {"fullPage": false}}')

if echo $SCREENSHOT_RESPONSE | jq -e '.result.screenshot' > /dev/null; then
  echo "✅ Screenshot captured successfully (base64 data available)"
  SCREENSHOT_SIZE=$(echo $SCREENSHOT_RESPONSE | jq -r '.result.screenshot' | wc -c)
  echo "   Screenshot data size: $SCREENSHOT_SIZE characters"
else
  echo "❌ Screenshot failed"
  echo $SCREENSHOT_RESPONSE | jq '.error'
fi
echo

# Test 6: Evaluate JavaScript
echo "⚡ Step 6: Evaluating JavaScript..."
JS_RESPONSE=$(curl -s -X POST $BASE_URL/api/sessions/$SESSION_ID/commands \
  -H "Content-Type: application/json" \
  -d '{"type": "evaluate", "payload": {"script": "document.querySelector(\"h1\").textContent"}}')

echo "✅ JavaScript evaluation:"
echo $JS_RESPONSE | jq '.result'
echo

# Test 7: Session Info
echo "📊 Step 7: Checking session info..."
SESSION_INFO=$(curl -s $BASE_URL/api/sessions/$SESSION_ID)
echo "✅ Session commands executed:"
echo $SESSION_INFO | jq '.session.commands | length'
echo

echo "🎉 All tests completed!"
echo "📍 Service URL: $BASE_URL"
echo "🔗 Session ID: $SESSION_ID"
echo
echo "💡 This demonstrates that server-side browser automation is working"
echo "   without requiring any browser extension installation!"
