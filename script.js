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

    // API configuration
    const API_BASE = window.location.origin;

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

        const screenshotDisplay = document.getElementById('screenshot-display');
        if (!screenshotDisplay) return;
        
        screenshotDisplay.innerHTML = '';
        screenshotDisplay.classList.add('has-screenshot');

        const img = document.createElement('img');
        if (screenshot.url) {
            // Handle relative URLs by making them absolute
            img.src = screenshot.url.startsWith('/') ? `${API_BASE}${screenshot.url}` : screenshot.url;
        } else if (screenshot.base64) {
            img.src = `data:image/png;base64,${screenshot.base64}`;
        }
        img.alt = 'Final task screenshot';
        img.onerror = () => {
            screenshotDisplay.innerHTML = '<p>Failed to load screenshot</p>';
            screenshotDisplay.classList.remove('has-screenshot');
        };
        
        const info = document.createElement('div');
        info.className = 'screenshot-info';
        const timestamp = screenshot.timestamp ? new Date(screenshot.timestamp).toLocaleTimeString() : 'now';
        info.textContent = `Screenshot taken at ${timestamp}`;

        screenshotDisplay.appendChild(img);
        screenshotDisplay.appendChild(info);
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

                    // Display final screenshot if available
                    if (result.screenshots && result.screenshots.final) {
                        displayScreenshot(result.screenshots.final);
                        logAction('📸 Final screenshot captured and displayed');
                    } else if (result.screenshots && result.screenshots.after) {
                        displayScreenshot(result.screenshots.after);
                        logAction('📸 Screenshot displayed');
                    }

                } catch (taskError) {
                    logAction(`❌ Task ${i + 1} failed: ${taskError.message}`);
                    console.error('Task execution error:', taskError);
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

    addTaskBtn.addEventListener('click', addTask);
    runTasksBtn.addEventListener('click', runAllTasks);
    downloadReceiptBtn.addEventListener('click', downloadReceipt);
    
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
