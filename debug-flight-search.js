#!/usr/bin/env node

const axios = require('axios');
const fs = require('fs');

async function debugFlightSearch() {
  const baseUrl = 'http://10.0.0.2:3010';
  
  try {
    console.log('🔬 Creating debug session for flight search...');
    
    // Create a session with debug enabled
    const sessionResponse = await axios.post(`${baseUrl}/api/sessions`, {
      metadata: {
        debug: true,
        browser: 'debug-analysis',
        purpose: 'flight-search-debug'
      }
    });
    
    const sessionId = sessionResponse.data.session.id;
    console.log(`✅ Session created: ${sessionId}`);
    
    // Start the flight search task
    console.log('🚀 Starting flight search task...');
    const taskResponse = await axios.post(`${baseUrl}/api/sessions/${sessionId}/nl-tasks`, {
      task: 'Search for the next flight from Frankfurt to London Heathrow'
    });
    
    console.log('⏳ Waiting for task completion...');
    console.log(`📋 Task status: ${taskResponse.status}`);
    console.log(`📋 Task response:`, taskResponse.data);
    
    // Wait a bit for the task to process
    await new Promise(resolve => setTimeout(resolve, 90000)); // 90 seconds
    
    // Get debug info
    console.log('\n📊 Fetching debug information...');
    
    const debugStatus = await axios.get(`${baseUrl}/api/sessions/${sessionId}/debug/status`);
    console.log('\n📈 Session Status:');
    console.log(`- Iterations: ${debugStatus.data.session.iterations || 'N/A'}`);
    console.log(`- History entries: ${debugStatus.data.historyCount}`);
    console.log(`- Last response: ${debugStatus.data.history[debugStatus.data.history.length - 1].content.slice(0, 100)}...`);
    
    const debugScreenshots = await axios.get(`${baseUrl}/api/sessions/${sessionId}/debug/screenshots`);
    console.log(`\n📸 Screenshots available: ${debugScreenshots.data.screenshots.length}`);
    
    if (debugScreenshots.data.screenshots.length > 0) {
      const latestScreenshot = debugScreenshots.data.screenshots[0];
      console.log(`📸 Latest screenshot: ${latestScreenshot.filename} (${latestScreenshot.size} bytes)`);
      
      // Download the latest screenshot
      try {
        const screenshotUrl = `${baseUrl}/api/sessions/${sessionId}/debug/screenshots/${latestScreenshot.filename}`;
        const screenshotResponse = await axios.get(screenshotUrl, { responseType: 'arraybuffer' });
        fs.writeFileSync('./latest-debug-screenshot.png', screenshotResponse.data);
        console.log('✅ Latest screenshot saved as latest-debug-screenshot.png');
      } catch (screenshotError) {
        console.log('❌ Failed to download screenshot:', screenshotError.message);
      }
    }
    
    // Clean up
    await axios.delete(`${baseUrl}/api/sessions/${sessionId}`);
    console.log('🧹 Session cleaned up');
    
  } catch (error) {
    console.error('❌ Error during debug:', error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
    }
  }
}

debugFlightSearch();
