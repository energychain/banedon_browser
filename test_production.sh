#!/bin/bash

# Weather Test Script for Mannheim using Browser Automation API
# This script automates fetching weather data for Mannheim, Germany

API_BASE="https://browserless.corrently.cloud"
WEATHER_URL="https://weather.com/weather/today/l/Mannheim+Baden-Wurttemberg+Germany"

echo "🌤️  Fetching weather data for Mannheim, Germany..."
echo "=================================================="

# Step 1: Create a new browser session
echo "📱 Creating browser session..."
SESSION_RESPONSE=$(curl -s -X POST "${API_BASE}/api/sessions" \
  -H "Content-Type: application/json" \
  -d '{
    "metadata": {
      "browser": "chrome",
      "purpose": "weather-data-extraction",
      "project": "mannheim-weather-test"
    },
    "options": {
      "timeout": 60000,
      "maxCommands": 50
    }
  }')

# Extract session ID
SESSION_ID=$(echo "$SESSION_RESPONSE" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)

if [ -z "$SESSION_ID" ]; then
    echo "❌ Failed to create session"
    echo "Response: $SESSION_RESPONSE"
    exit 1
fi

echo "✅ Session created: $SESSION_ID"

# Step 2: Navigate to weather website (try multiple sources)
echo "🌐 Navigating to weather website..."

# Try multiple weather sources if the first one fails
WEATHER_SOURCES=(
  "https://weather.com/weather/today/l/Mannheim+Germany"
  "https://duckduckgo.com/?q=Wetter+in+Mannheim&t=chromentp&ia=web"
  "https://openweathermap.org/city/2873891"
  "https://www.timeanddate.com/weather/germany/mannheim"
)

NAVIGATE_SUCCESS=false
for WEATHER_URL in "${WEATHER_SOURCES[@]}"; do
  echo "🔗 Trying: $WEATHER_URL"
  
  NAVIGATE_RESPONSE=$(curl -s -X POST "${API_BASE}/api/sessions/${SESSION_ID}/commands" \
    -H "Content-Type: application/json" \
    -d "{
      \"type\": \"navigate\",
      \"payload\": {
        \"url\": \"${WEATHER_URL}\",
        \"timeout\": 30000
      }
    }")
  
  # Check if navigation was successful
  NAVIGATE_STATUS=$(echo "$NAVIGATE_RESPONSE" | jq -r '.success // false')
  RESPONSE_TITLE=$(echo "$NAVIGATE_RESPONSE" | jq -r '.command.result.title // "unknown"')
  
  if [ "$NAVIGATE_STATUS" = "true" ] && [ "$RESPONSE_TITLE" != "404 Not Found" ]; then
    echo "✅ Successfully navigated to: $WEATHER_URL"
    echo "📄 Page title: $RESPONSE_TITLE"
    NAVIGATE_SUCCESS=true
    break
  else
    echo "❌ Failed: $RESPONSE_TITLE"
  fi
done

if [ "$NAVIGATE_SUCCESS" = "false" ]; then
  echo "⚠️  All weather sources failed, but continuing with AI extraction..."
fi

# Step 3: Take screenshot to verify page loaded (silent)
echo "📸 Taking screenshot for verification..."
SCREENSHOT_RESPONSE=$(curl -s -X POST "${API_BASE}/api/sessions/${SESSION_ID}/commands" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "screenshot",
    "payload": {
      "fullPage": false,
      "timeout": 15000
    }
  }')

SCREENSHOT_STATUS=$(echo "$SCREENSHOT_RESPONSE" | jq -r '.status // "unknown"')
echo "📷 Screenshot status: $SCREENSHOT_STATUS"

# Step 4: Use natural language task to extract weather information
echo "🤖 Extracting weather data using AI..."
TASK_RESPONSE=$(curl -s -X POST "${API_BASE}/api/sessions/${SESSION_ID}/nl-tasks" \
  -H "Content-Type: application/json" \
  -d '{
    "task": "What is the current weather in Mannheim, Germany? Please provide temperature, conditions, humidity, and any other weather information you can find on this page."
  }')

echo "🌡️  Weather extraction result:"
WEATHER_DATA=$(echo "$TASK_RESPONSE" | jq -r '.task.response // .task.description // .error // "No weather data extracted"')
echo "$WEATHER_DATA"

# Check if we got meaningful weather data
if echo "$WEATHER_DATA" | grep -qiE "(temperature|weather|°|celsius|fahrenheit|humidity|wind|rain|cloud|sunny|cloudy)"; then
  echo "✅ Weather information successfully extracted!"
else
  echo "⚠️  No detailed weather information found, trying alternative approach..."
fi

# Step 5: Alternative approach - Try Google search for weather
echo "🔍 Attempting Google search for weather..."
GOOGLE_RESPONSE=$(curl -s -X POST "${API_BASE}/api/sessions/${SESSION_ID}/commands" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "navigate",
    "payload": {
      "url": "https://www.google.com/search?q=weather+Mannheim+Germany+current+temperature"
    }
  }')

# Give it time to load
sleep 3

# Try AI extraction again with Google results
GOOGLE_TASK_RESPONSE=$(curl -s -X POST "${API_BASE}/api/sessions/${SESSION_ID}/nl-tasks" \
  -H "Content-Type: application/json" \
  -d '{
    "task": "Look at this Google search results page and tell me the current weather in Mannheim, Germany. What temperature, weather conditions, and other weather details can you see?"
  }')

echo "🌡️  Google weather search result:"
GOOGLE_WEATHER=$(echo "$GOOGLE_TASK_RESPONSE" | jq -r '.task.response // .task.description // "No weather data found"')
echo "$GOOGLE_WEATHER"

# Step 6: Get page title and URL for verification
echo "📰 Getting page information..."
TITLE_RESPONSE=$(curl -s -X POST "${API_BASE}/api/sessions/${SESSION_ID}/commands" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "getTitle",
    "payload": {
      "timeout": 5000
    }
  }')

URL_RESPONSE=$(curl -s -X POST "${API_BASE}/api/sessions/${SESSION_ID}/commands" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "getUrl",
    "payload": {
      "timeout": 5000
    }
  }')

CURRENT_TITLE=$(echo "$TITLE_RESPONSE" | jq -r '.command.result.title // .result.title // "Title not found"')
CURRENT_URL=$(echo "$URL_RESPONSE" | jq -r '.command.result.url // .result.url // "URL not found"')

echo "📋 Current page: $CURRENT_TITLE"
echo "🔗 Current URL: $CURRENT_URL"

# Step 7: Clean up - Delete the session
echo "🧹 Cleaning up session..."
DELETE_RESPONSE=$(curl -s -X DELETE "${API_BASE}/api/sessions/${SESSION_ID}")
echo "✅ Session cleanup: $(echo "$DELETE_RESPONSE" | jq -r '.message // "Session deleted"')"

echo ""
echo "=================================================="
echo "✨ Weather test script completed for Mannheim!"
echo "=================================================="

# Optional: Alternative quick test for API health
echo ""
echo "🏥 Testing API health..."
HEALTH_RESPONSE=$(curl -s "${API_BASE}/health")
echo "API Status: $(echo "$HEALTH_RESPONSE" | jq -r '.status // "Unknown"')"
echo "Uptime: $(echo "$HEALTH_RESPONSE" | jq -r '.uptime // "Unknown"') ms"
