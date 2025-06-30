document.addEventListener('DOMContentLoaded', () => {
    const taskInput = document.getElementById('task-input');
    const addTaskBtn = document.getElementById('add-task-btn');
    const taskList = document.getElementById('task-list');
    const runTasksBtn = document.getElementById('run-tasks-btn');
    const executionStatus = document.getElementById('execution-status');
    const screenshotDisplay = document.getElementById('screenshot-display');
    const downloadReceiptBtn = document.getElementById('download-receipt-btn');
    const actionLog = document.getElementById('action-log');

    let tasks = [];
    let draggedIndex = null;
    let currentSessionId = null;
    let isExecuting = false;
    let liveViewInterval = null;
    let isLiveViewActive = false;
    let isClickMode = false;
    let isTypeMode = false;

    // API configuration
    const API_BASE = window.location.origin;

    // Interactive API functions
    async function sendInteractiveCommand(sessionId, command) {
        try {
            const response = await fetch(`${API_BASE}/api/sessions/${sessionId}/interactive`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    command: command
                })
            });

            if (!response.ok) {
                throw new Error(`Interactive command failed: ${response.statusText}`);
            }

            const data = await response.json();
            return data;
        } catch (error) {
            console.error('Error sending interactive command:', error);
            throw error;
        }
    }

    async function getCurrentScreenshot(sessionId) {
        try {
            const response = await fetch(`${API_BASE}/api/sessions/${sessionId}/screenshot`);
            
            if (!response.ok) {
                throw new Error(`Failed to get screenshot: ${response.statusText}`);
            }

            const data = await response.json();
            return data;
        } catch (error) {
            console.error('Error getting screenshot:', error);
            throw error;
        }
    }

    async function getSessionState(sessionId) {
        try {
            const response = await fetch(`${API_BASE}/api/sessions/${sessionId}/state`);
            
            if (!response.ok) {
                throw new Error(`Failed to get session state: ${response.statusText}`);
            }

            const data = await response.json();
            return data;
        } catch (error) {
            console.error('Error getting session state:', error);
            throw error;
        }
    }

    // Interactive mode functions
    function enableInteractiveMode() {
        const interactiveControls = document.getElementById('interactive-controls');
        if (currentSessionId && interactiveControls) {
            interactiveControls.style.display = 'block';
            logAction('🎮 Interactive mode enabled');
        }
    }

    function disableInteractiveMode() {
        const interactiveControls = document.getElementById('interactive-controls');
        if (interactiveControls) {
            interactiveControls.style.display = 'none';
            stopLiveView();
            logAction('🎮 Interactive mode disabled');
        }
    }

    async function startLiveView() {
        if (!currentSessionId) {
            logAction('❌ No active session for live view');
            return;
        }

        if (isLiveViewActive) {
            stopLiveView();
            return;
        }

        isLiveViewActive = true;
        const liveViewBtn = document.getElementById('enable-live-view');
        if (liveViewBtn) {
            liveViewBtn.textContent = '⏹️ Stop Live View';
            liveViewBtn.classList.add('btn-danger');
        }

        const screenshotDisplay = document.getElementById('screenshot-display');
        if (screenshotDisplay) {
            screenshotDisplay.classList.add('live-view-active');
        }

        logAction('📹 Live view started');

        liveViewInterval = setInterval(async () => {
            try {
                const data = await getCurrentScreenshot(currentSessionId);
                if (data.success && data.screenshot) {
                    updateScreenshotDisplay(data.screenshot, false); // Don't log each update
                    
                    // Update session state indicators
                    if (data.sessionState && data.sessionState.isPaused) {
                        screenshotDisplay.classList.add('session-paused');
                        updateInteractionStatus(`⏸️ Session paused: ${data.sessionState.pauseReason || 'Unknown reason'}`);
                    } else {
                        screenshotDisplay.classList.remove('session-paused');
                    }
                }
            } catch (error) {
                console.error('Live view update failed:', error);
                // Don't spam the log with live view errors
            }
        }, 2000); // Update every 2 seconds
    }

    function stopLiveView() {
        isLiveViewActive = false;
        
        if (liveViewInterval) {
            clearInterval(liveViewInterval);
            liveViewInterval = null;
        }

        const liveViewBtn = document.getElementById('enable-live-view');
        if (liveViewBtn) {
            liveViewBtn.textContent = '📹 Live View';
            liveViewBtn.classList.remove('btn-danger');
        }

        const screenshotDisplay = document.getElementById('screenshot-display');
        if (screenshotDisplay) {
            screenshotDisplay.classList.remove('live-view-active');
        }

        logAction('📹 Live view stopped');
    }

    function enableClickMode() {
        if (!currentSessionId) {
            logAction('❌ No active session for click mode');
            return;
        }

        isClickMode = !isClickMode;
        isTypeMode = false; // Disable type mode

        const clickBtn = document.getElementById('click-mode');
        const typeBtn = document.getElementById('type-mode');
        const screenshotDisplay = document.getElementById('screenshot-display');

        if (isClickMode) {
            clickBtn.textContent = '🖱️ Click: ON';
            clickBtn.classList.add('btn-success');
            screenshotDisplay.classList.add('screenshot-interactive');
            updateInteractionStatus('🖱️ Click mode active - Click anywhere on the screenshot to interact');
            logAction('🖱️ Click mode enabled');
        } else {
            clickBtn.textContent = '🖱️ Click Mode';
            clickBtn.classList.remove('btn-success');
            screenshotDisplay.classList.remove('screenshot-interactive');
            updateInteractionStatus('💡 Click mode disabled');
            logAction('🖱️ Click mode disabled');
        }

        // Reset type button
        if (typeBtn) {
            typeBtn.textContent = '⌨️ Type Mode';
            typeBtn.classList.remove('btn-success');
        }
        document.getElementById('type-text').style.display = 'none';
    }

    function enableTypeMode() {
        if (!currentSessionId) {
            logAction('❌ No active session for type mode');
            return;
        }

        isTypeMode = !isTypeMode;
        isClickMode = false; // Disable click mode

        const typeBtn = document.getElementById('type-mode');
        const clickBtn = document.getElementById('click-mode');
        const typeInput = document.getElementById('type-text');
        const screenshotDisplay = document.getElementById('screenshot-display');

        if (isTypeMode) {
            typeBtn.textContent = '⌨️ Type: ON';
            typeBtn.classList.add('btn-success');
            typeInput.style.display = 'block';
            typeInput.focus();
            updateInteractionStatus('⌨️ Type mode active - Enter text and press Enter to type');
            logAction('⌨️ Type mode enabled');
        } else {
            typeBtn.textContent = '⌨️ Type Mode';
            typeBtn.classList.remove('btn-success');
            typeInput.style.display = 'none';
            updateInteractionStatus('💡 Type mode disabled');
            logAction('⌨️ Type mode disabled');
        }

        // Reset click button and mode
        if (clickBtn) {
            clickBtn.textContent = '🖱️ Click Mode';
            clickBtn.classList.remove('btn-success');
        }
        screenshotDisplay.classList.remove('screenshot-interactive');
    }

    function updateInteractionStatus(message) {
        const statusElement = document.getElementById('interaction-status');
        if (statusElement) {
            statusElement.innerHTML = `<small>${message}</small>`;
        }
    }

    function updateScreenshotDisplay(screenshot, shouldLog = true) {
        const screenshotDisplay = document.getElementById('screenshot-display');
        if (!screenshotDisplay || !screenshot) return;

        // Clear existing content but preserve classes
        const existingClasses = screenshotDisplay.className;
        screenshotDisplay.innerHTML = '';
        screenshotDisplay.className = existingClasses + ' has-screenshot';

        const img = document.createElement('img');
        if (screenshot.base64) {
            img.src = `data:image/png;base64,${screenshot.base64}`;
        } else if (screenshot.url) {
            img.src = screenshot.url.startsWith('/') ? `${API_BASE}${screenshot.url}` : screenshot.url;
        }
        img.alt = 'Browser screenshot';
        
        img.onerror = () => {
            screenshotDisplay.innerHTML = '<p>Failed to load screenshot</p>';
            screenshotDisplay.classList.remove('has-screenshot');
        };

        // Add click handler for interactive mode
        img.onclick = async (e) => {
            if (isClickMode && currentSessionId) {
                const rect = img.getBoundingClientRect();
                const scaleX = img.naturalWidth / img.width;
                const scaleY = img.naturalHeight / img.height;
                
                const x = Math.round((e.clientX - rect.left) * scaleX);
                const y = Math.round((e.clientY - rect.top) * scaleY);

                // Show click coordinates
                const clickIndicator = document.createElement('div');
                clickIndicator.className = 'click-coordinates';
                clickIndicator.textContent = `(${x}, ${y})`;
                clickIndicator.style.left = (e.clientX - rect.left) + 'px';
                clickIndicator.style.top = (e.clientY - rect.top) + 'px';
                screenshotDisplay.appendChild(clickIndicator);

                try {
                    logAction(`🖱️ Clicking at coordinates (${x}, ${y})`);
                    const result = await sendInteractiveCommand(currentSessionId, {
                        type: 'click',
                        x: x,
                        y: y
                    });

                    if (result.success) {
                        logAction(`✅ Click successful at (${x}, ${y})`);
                        if (result.screenshot) {
                            // Update screenshot after click
                            setTimeout(() => updateScreenshotDisplay(result.screenshot), 1000);
                        }
                    }
                } catch (error) {
                    logAction(`❌ Click failed: ${error.message}`);
                }
            }
        };

        const info = document.createElement('div');
        info.className = 'screenshot-info';
        const timestamp = screenshot.timestamp ? new Date(screenshot.timestamp).toLocaleTimeString() : 'now';
        info.textContent = `Screenshot taken at ${timestamp}`;

        screenshotDisplay.appendChild(img);
        screenshotDisplay.appendChild(info);

        if (shouldLog) {
            logAction('📸 Screenshot updated');
        }
    }

    async function pauseSession() {
        if (!currentSessionId) {
            logAction('❌ No active session to pause');
            return;
        }

        try {
            const result = await sendInteractiveCommand(currentSessionId, {
                type: 'pause',
                reason: 'manual_pause'
            });

            if (result.success) {
                logAction('⏸️ Session paused manually');
                updateInteractionStatus('⏸️ Session is paused - click Resume to continue');
            }
        } catch (error) {
            logAction(`❌ Failed to pause session: ${error.message}`);
        }
    }

    async function resumeSession() {
        if (!currentSessionId) {
            logAction('❌ No active session to resume');
            return;
        }

        try {
            const result = await sendInteractiveCommand(currentSessionId, {
                type: 'resume'
            });

            if (result.success) {
                logAction('▶️ Session resumed');
                updateInteractionStatus('▶️ Session resumed - ready for interaction');
            }
        } catch (error) {
            logAction(`❌ Failed to resume session: ${error.message}`);
        }
    }

    async function sendTypeCommand(text) {
        if (!currentSessionId || !text.trim()) {
            return;
        }

        try {
            logAction(`⌨️ Typing: "${text}"`);
            const result = await sendInteractiveCommand(currentSessionId, {
                type: 'type',
                text: text
            });

            if (result.success) {
                logAction(`✅ Text typed successfully: "${text}"`);
                if (result.screenshot) {
                    // Update screenshot after typing
                    setTimeout(() => updateScreenshotDisplay(result.screenshot), 1000);
                }
                
                // Clear the input
                document.getElementById('type-text').value = '';
            }
        } catch (error) {
            logAction(`❌ Typing failed: ${error.message}`);
        }
    }

    function renderTasks() {
        taskList.innerHTML = '';
        tasks.forEach((task, index) => {
            const li = document.createElement('li');
            li.dataset.index = index;
            li.setAttribute('draggable', 'true');

            // Check if the task is being edited
            if (task.isEditing) {
                li.innerHTML = `
                    <input type="text" class="edit-input" value="${task.description}">
                    <div class="task-actions">
                        <button class="save-btn" title="Save Task">✔️</button>
                    </div>
                `;
            } else {
                li.innerHTML = `
                    <span class="task-text">${task.description}</span>
                    <div class="task-actions">
                        <button class="edit-btn" title="Edit Task">✏️</button>
                        <button class="delete-btn" title="Delete Task">🗑️</button>
                    </div>
                `;
            }
            taskList.appendChild(li);
        });
    }

    function addTask() {
        const taskDescription = taskInput.value.trim();
        if (taskDescription) {
            tasks.push({
                id: Date.now(),
                type: 'user-question',
                description: taskDescription,
                isEditing: false // Add editing state
            });
            taskInput.value = '';
            renderTasks();
            logAction(`Task added: "${taskDescription}"`);
        }
    }

    function deleteTask(index) {
        const taskDescription = tasks[index].description;
        tasks.splice(index, 1);
        renderTasks();
        logAction(`Task removed: "${taskDescription}"`);
    }

    function toggleEditState(index) {
        tasks.forEach((task, i) => {
            task.isEditing = (i === index);
        });
        renderTasks();
        // Focus the new input field
        const editInput = taskList.querySelector('.edit-input');
        if (editInput) {
            editInput.focus();
            editInput.select();
        }
    }

    function saveTask(index, newDescription) {
        const oldDescription = tasks[index].description;
        if (newDescription && newDescription.trim() !== '') {
            tasks[index].description = newDescription.trim();
            logAction(`Task edited from "${oldDescription}" to "${newDescription.trim()}"`);
        }
        tasks[index].isEditing = false;
        renderTasks();
    }

    function logAction(message) {
        const logEntry = document.createElement('div');
        logEntry.className = 'log-entry';
        logEntry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
        actionLog.appendChild(logEntry);
        actionLog.scrollTop = actionLog.scrollHeight; // Auto-scroll
    }

    function generateReceipt() {
        const receipt = {
            version: "1.0",
            createdAt: new Date().toISOString(),
            tasks: tasks.map(task => ({
                id: task.id,
                type: task.type,
                params: {
                    query: task.description
                }
            }))
        };
        return receipt;
    }

    function downloadReceipt() {
        const receipt = generateReceipt();
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(receipt, null, 2));
        const downloadAnchorNode = document.createElement('a');
        downloadAnchorNode.setAttribute("href", dataStr);
        downloadAnchorNode.setAttribute("download", `receipt-${Date.now()}.json`);
        document.body.appendChild(downloadAnchorNode); // required for firefox
        downloadAnchorNode.click();
        downloadAnchorNode.remove();
        logAction('Receipt downloaded.');
    }

    function showReceiptStatus(message, type = 'info') {
        const statusDiv = document.getElementById('receipt-status');
        statusDiv.textContent = message;
        statusDiv.className = `status-message ${type}`;
        statusDiv.style.display = 'block';
        
        // Auto-hide after 5 seconds unless it's an error
        if (type !== 'error') {
            setTimeout(() => {
                statusDiv.style.display = 'none';
            }, 5000);
        }
    }

    function validateReceipt(receipt) {
        if (!receipt || typeof receipt !== 'object') {
            throw new Error('Invalid receipt format: must be a JSON object');
        }
        
        if (!receipt.version) {
            throw new Error('Invalid receipt: missing version field');
        }
        
        if (!Array.isArray(receipt.tasks)) {
            throw new Error('Invalid receipt: tasks must be an array');
        }
        
        receipt.tasks.forEach((task, index) => {
            if (!task.id) {
                throw new Error(`Invalid task at index ${index}: missing id`);
            }
            if (!task.type) {
                throw new Error(`Invalid task at index ${index}: missing type`);
            }
            if (!task.params || !task.params.query) {
                throw new Error(`Invalid task at index ${index}: missing params.query`);
            }
        });
        
        return true;
    }

    async function runReceiptTasks(receipt) {
        if (!currentSessionId) {
            // Create a new session if none exists
            await createSession();
        }
        
        // Clear existing tasks and add receipt tasks
        tasks = [];
        renderTaskList();
        
        // Add tasks from receipt
        for (const receiptTask of receipt.tasks) {
            const task = {
                id: Date.now() + Math.random(), // Generate new ID for UI
                type: receiptTask.type,
                description: receiptTask.params.query,
                status: 'pending'
            };
            tasks.push(task);
        }
        
        renderTaskList();
        showReceiptStatus(`Loaded ${receipt.tasks.length} tasks from receipt. Running tasks...`, 'info');
        logAction(`Receipt loaded with ${receipt.tasks.length} tasks.`);
        
        // Run the tasks
        await runAllTasks();
    }

    async function runReceiptViaAPI(receipt) {
        try {
            showReceiptStatus('Uploading receipt to server...', 'info');
            
            const response = await fetch(`${API_BASE}/api/receipts/run`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(receipt)
            });
            
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: 'Unknown server error' }));
                throw new Error(errorData.error || `Server error: ${response.statusText}`);
            }
            
            const result = await response.json();
            showReceiptStatus(`Receipt executed successfully! Session ID: ${result.sessionId}`, 'success');
            logAction(`Receipt executed via API. Session: ${result.sessionId}`);
            
            // Optionally switch to this session to view results
            if (result.sessionId) {
                currentSessionId = result.sessionId;
                // Fetch and display any screenshots or results
                await getCurrentScreenshot(currentSessionId);
            }
            
            return result;
        } catch (error) {
            showReceiptStatus(`API execution failed: ${error.message}`, 'error');
            logAction(`Receipt API execution failed: ${error.message}`);
            throw error;
        }
    }

    function handleReceiptUpload() {
        const fileInput = document.getElementById('receipt-file-input');
        const file = fileInput.files[0];
        
        if (!file) {
            showReceiptStatus('Please select a receipt file', 'error');
            return;
        }
        
        if (!file.name.endsWith('.json')) {
            showReceiptStatus('Please select a JSON file', 'error');
            return;
        }
        
        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const receiptText = e.target.result;
                const receipt = JSON.parse(receiptText);
                
                // Validate receipt format
                validateReceipt(receipt);
                
                showReceiptStatus('Receipt validated successfully. Choose execution method:', 'success');
                logAction(`Receipt file "${file.name}" loaded and validated.`);
                
                // Show execution options
                const confirmDialog = confirm(
                    `Receipt loaded with ${receipt.tasks.length} tasks.\n\n` +
                    'Choose execution method:\n' +
                    'OK = Run locally in browser\n' +
                    'Cancel = Run via server API'
                );
                
                if (confirmDialog) {
                    // Run locally
                    await runReceiptTasks(receipt);
                } else {
                    // Run via API
                    await runReceiptViaAPI(receipt);
                }
                
            } catch (error) {
                if (error instanceof SyntaxError) {
                    showReceiptStatus('Invalid JSON file format', 'error');
                } else {
                    showReceiptStatus(`Error: ${error.message}`, 'error');
                }
                logAction(`Receipt upload error: ${error.message}`);
            }
        };
        
        reader.onerror = () => {
            showReceiptStatus('Error reading file', 'error');
        };
        
        reader.readAsText(file);
    }

    // API functions
    async function createSession() {
        try {
            const response = await fetch(`${API_BASE}/api/sessions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    metadata: {
                        browser: 'chrome',
                        purpose: 'frontend-task-execution',
                        project: 'banedon-browser-frontend'
                    },
                    options: {
                        timeout: 120000,
                        maxCommands: 100
                    }
                })
            });

            if (!response.ok) {
                throw new Error(`Failed to create session: ${response.statusText}`);
            }

            const data = await response.json();
            console.log('Session creation response:', data); // Debug log
            
            if (!data.success || !data.session || !data.session.id) {
                throw new Error('Invalid session creation response');
            }
            
            return data.session.id;
        } catch (error) {
            console.error('Error creating session:', error);
            throw error;
        }
    }

    async function executeTask(sessionId, taskDescription) {
        try {
            if (!sessionId) {
                throw new Error('No valid session ID provided');
            }
            
            const response = await fetch(`${API_BASE}/api/sessions/${sessionId}/nl-tasks`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    task: taskDescription
                })
            });

            if (!response.ok) {
                throw new Error(`Failed to execute task: ${response.statusText}`);
            }

            const data = await response.json();
            console.log('Task execution response:', data); // Debug log
            return data.task;
        } catch (error) {
            console.error('Error executing task:', error);
            throw error;
        }
    }

    async function deleteSession(sessionId) {
        try {
            await fetch(`${API_BASE}/api/sessions/${sessionId}`, {
                method: 'DELETE'
            });
        } catch (error) {
            console.error('Error deleting session:', error);
        }
    }

    function displayScreenshot(screenshot) {
        if (!screenshot || (!screenshot.url && !screenshot.base64)) {
            return;
        }

        updateScreenshotDisplay(screenshot, true);
    }

    function updateExecutionStatus(status, message, type = '') {
        const executionStatus = document.getElementById('execution-status');
        if (!executionStatus) return;
        
        executionStatus.textContent = message;
        executionStatus.className = type;
        executionStatus.style.display = message ? 'block' : 'none';
    }

    async function runAllTasks() {
        if (tasks.length === 0) {
            updateExecutionStatus('error', 'No tasks to execute', 'error');
            return;
        }

        if (isExecuting) {
            return;
        }

        isExecuting = true;
        const runTasksBtn = document.getElementById('run-tasks-btn');
        if (runTasksBtn) {
            runTasksBtn.disabled = true;
            runTasksBtn.textContent = 'Running...';
        }

        try {
            updateExecutionStatus('running', 'Creating browser session...', 'running');
            logAction('Starting task execution...');
            
            // Clear previous task response
            clearTaskResponse();

            // Create a new session
            currentSessionId = await createSession();
            logAction(`Created session: ${currentSessionId}`);

            // Execute tasks sequentially
            for (let i = 0; i < tasks.length; i++) {
                const task = tasks[i];
                updateExecutionStatus('running', `Executing task ${i + 1}/${tasks.length}: ${task.description.substring(0, 50)}...`, 'running');
                logAction(`Executing: "${task.description}"`);

                try {
                    const result = await executeTask(currentSessionId, task.description);
                    logAction(`✅ Task ${i + 1} completed: ${result.response ? result.response.substring(0, 100) + '...' : 'Success'}`);

                    // Display task response prominently
                    displayTaskResponse(result, task.description);

                    // Display final screenshot if available
                    if (result.screenshots && result.screenshots.final) {
                        displayScreenshot(result.screenshots.final);
                        logAction('📸 Final screenshot captured and displayed');
                    } else if (result.screenshots && result.screenshots.after) {
                        displayScreenshot(result.screenshots.after);
                        logAction('📸 Screenshot displayed');
                    }

                    // Enable interactive mode after task completion
                    enableInteractiveMode();

                } catch (taskError) {
                    logAction(`❌ Task ${i + 1} failed: ${taskError.message}`);
                    console.error('Task execution error:', taskError);
                    
                    // Display error response prominently
                    displayTaskResponse({
                        success: false,
                        error: taskError.message,
                        execution: { iterations: 0, duration: 0 }
                    }, task.description);
                }

                // Add a small delay between tasks
                if (i < tasks.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }

            updateExecutionStatus('completed', `All ${tasks.length} tasks completed successfully!`, 'completed');
            logAction('🎉 All tasks completed!');

        } catch (error) {
            updateExecutionStatus('error', `Execution failed: ${error.message}`, 'error');
            logAction(`❌ Execution failed: ${error.message}`);
            console.error('Execution error:', error);
        } finally {
            // Clean up session
            if (currentSessionId) {
                try {
                    // Disable interactive mode before cleanup
                    disableInteractiveMode();
                    
                    await deleteSession(currentSessionId);
                    logAction('🧹 Session cleaned up');
                } catch (cleanupError) {
                    console.error('Session cleanup error:', cleanupError);
                }
                currentSessionId = null;
            }

            isExecuting = false;
            if (runTasksBtn) {
                runTasksBtn.disabled = false;
                runTasksBtn.textContent = 'Run Tasks';
            }

            // Hide status after some time
            setTimeout(() => {
                const executionStatus = document.getElementById('execution-status');
                if (executionStatus && executionStatus.classList.contains('completed')) {
                    updateExecutionStatus('', '', '');
                }
            }, 10000);
        }
    }

    // Response display functions
    function displayTaskResponse(taskResult, taskDescription) {
        const responseContainer = document.getElementById('task-response-container');
        const responseDisplay = document.getElementById('task-response-display');
        
        if (!responseContainer || !responseDisplay || !taskResult) {
            return;
        }

        // Show the response container
        responseContainer.style.display = 'block';
        
        // Clear previous content
        responseDisplay.innerHTML = '';
        responseDisplay.className = '';

        // Determine if this is an error or success
        const isError = !taskResult.success || taskResult.error;
        const responseText = taskResult.response || taskResult.error || 'No response available';
        
        // Apply appropriate styling
        if (isError) {
            responseDisplay.classList.add('has-error');
        } else {
            responseDisplay.classList.add('has-response');
        }

        // Create response header
        const header = document.createElement('div');
        header.className = 'response-header';
        header.innerHTML = `
            ${isError ? '❌' : '✅'} Response for: "${taskDescription.substring(0, 60)}${taskDescription.length > 60 ? '...' : ''}"
        `;

        // Create response content
        const content = document.createElement('div');
        content.className = 'response-content';
        content.textContent = responseText;

        // Create metadata section
        const metadata = document.createElement('div');
        metadata.className = 'response-metadata';
        
        const timestamp = new Date().toLocaleString();
        const iterations = taskResult.iterations || taskResult.execution?.iterations || 0;
        const duration = taskResult.execution?.duration || 0;
        
        metadata.innerHTML = `
            <span>📅 ${timestamp}</span>
            <span>🔄 ${iterations} iterations</span>
            <span>⏱️ ${Math.round(duration / 1000)}s</span>
            <button class="copy-response-btn" onclick="copyResponseToClipboard('${responseText.replace(/'/g, "\\'")}')">📋 Copy</button>
        `;

        // Assemble the response display
        responseDisplay.appendChild(header);
        responseDisplay.appendChild(content);
        responseDisplay.appendChild(metadata);

        // Scroll the response into view
        responseContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        
        logAction(`💬 Task response displayed prominently`);
    }

    // Global function for copy button (needed for onclick in HTML)
    window.copyResponseToClipboard = function(text) {
        navigator.clipboard.writeText(text).then(() => {
            logAction('📋 Response copied to clipboard');
            
            // Show temporary feedback
            const btn = event.target;
            const originalText = btn.textContent;
            btn.textContent = '✅ Copied';
            setTimeout(() => {
                btn.textContent = originalText;
            }, 2000);
        }).catch(err => {
            console.error('Failed to copy text: ', err);
            logAction('❌ Failed to copy response to clipboard');
            
            // Fallback for older browsers
            const textArea = document.createElement('textarea');
            textArea.value = text;
            document.body.appendChild(textArea);
            textArea.select();
            try {
                document.execCommand('copy');
                logAction('📋 Response copied to clipboard (fallback)');
            } catch (fallbackErr) {
                logAction('❌ Copy to clipboard not supported');
            }
            document.body.removeChild(textArea);
        });
    };

    function hideTaskResponse() {
        const responseContainer = document.getElementById('task-response-container');
        if (responseContainer) {
            responseContainer.style.display = 'none';
        }
    }

    function clearTaskResponse() {
        const responseDisplay = document.getElementById('task-response-display');
        if (responseDisplay) {
            responseDisplay.innerHTML = '<p>Task responses will appear here...</p>';
            responseDisplay.className = '';
        }
        hideTaskResponse();
    }

    addTaskBtn.addEventListener('click', addTask);
    runTasksBtn.addEventListener('click', runAllTasks);
    downloadReceiptBtn.addEventListener('click', downloadReceipt);
    
    // Receipt upload functionality
    const uploadReceiptBtn = document.getElementById('upload-receipt-btn');
    const receiptFileInput = document.getElementById('receipt-file-input');
    
    uploadReceiptBtn.addEventListener('click', () => {
        receiptFileInput.click();
    });
    
    receiptFileInput.addEventListener('change', handleReceiptUpload);
    
    // Interactive control event listeners
    document.getElementById('enable-live-view').addEventListener('click', startLiveView);
    document.getElementById('click-mode').addEventListener('click', enableClickMode);
    document.getElementById('type-mode').addEventListener('click', enableTypeMode);
    document.getElementById('pause-session').addEventListener('click', pauseSession);
    document.getElementById('resume-session').addEventListener('click', resumeSession);
    
    // Type input handler
    document.getElementById('type-text').addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && isTypeMode) {
            sendTypeCommand(e.target.value);
        }
    });
    
    taskInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            addTask();
        }
    });

    taskList.addEventListener('click', (e) => {
        const deleteBtn = e.target.closest('.delete-btn');
        const editBtn = e.target.closest('.edit-btn');
        const saveBtn = e.target.closest('.save-btn');

        if (deleteBtn) {
            const li = e.target.closest('li');
            const index = parseInt(li.dataset.index, 10);
            deleteTask(index);
            return;
        }

        if (editBtn) {
            const li = e.target.closest('li');
            const index = parseInt(li.dataset.index, 10);
            toggleEditState(index);
            return;
        }

        if (saveBtn) {
            const li = e.target.closest('li');
            const index = parseInt(li.dataset.index, 10);
            const input = li.querySelector('.edit-input');
            saveTask(index, input.value);
            return;
        }
    });

    // Handle saving task on Enter key press in edit mode
    taskList.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && e.target.classList.contains('edit-input')) {
            const li = e.target.closest('li');
            const index = parseInt(li.dataset.index, 10);
            saveTask(index, e.target.value);
        }
    });

    // Handle saving task on blur
    taskList.addEventListener('focusout', (e) => {
        if (e.target.classList.contains('edit-input')) {
            const li = e.target.closest('li');
            const index = parseInt(li.dataset.index, 10);
            // Make sure we don't save if the save button was clicked
            if (!e.relatedTarget || !e.relatedTarget.classList.contains('save-btn')) {
                 saveTask(index, e.target.value);
            }
        }
    });

    // Drag and Drop functionality
    taskList.addEventListener('dragstart', (e) => {
        const li = e.target.closest('li');
        if (!li) return;
        draggedIndex = parseInt(li.dataset.index, 10);
        e.dataTransfer.effectAllowed = 'move';
        // Add a class to the dragged item for styling
        setTimeout(() => li.classList.add('dragging'), 0);
        logAction(`Start dragging task: "${tasks[draggedIndex].description}"`);
    });

    taskList.addEventListener('dragend', (e) => {
        const li = e.target.closest('li');
        if (!li) return;
        li.classList.remove('dragging');
    });

    taskList.addEventListener('dragover', (e) => {
        e.preventDefault(); // Allow dropping
        const targetLi = e.target.closest('li');
        if (!targetLi || parseInt(targetLi.dataset.index, 10) === draggedIndex) {
            return;
        }
        // Remove previous indicators
        document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
        targetLi.classList.add('drag-over');
    });

    taskList.addEventListener('dragleave', (e) => {
        const targetLi = e.target.closest('li');
        if (targetLi) {
            targetLi.classList.remove('drag-over');
        }
    });

    taskList.addEventListener('drop', (e) => {
        e.preventDefault();
        document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
        const targetLi = e.target.closest('li');
        if (!targetLi || draggedIndex === null) return;

        const droppedOnIndex = parseInt(targetLi.dataset.index, 10);
        
        // Remove the dragged item from its original position
        const [draggedItem] = tasks.splice(draggedIndex, 1);
        // Insert it at the new position
        tasks.splice(droppedOnIndex, 0, draggedItem);

        logAction(`Task moved from position ${draggedIndex + 1} to ${droppedOnIndex + 1}`);
        
        draggedIndex = null;
        renderTasks();
    });


    // Initial render
    renderTasks();
    logAction('Interface initialized.');
});
