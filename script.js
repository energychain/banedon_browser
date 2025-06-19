document.addEventListener('DOMContentLoaded', () => {
    const taskInput = document.getElementById('task-input');
    const addTaskBtn = document.getElementById('add-task-btn');
    const taskList = document.getElementById('task-list');
    const downloadReceiptBtn = document.getElementById('download-receipt-btn');
    const actionLog = document.getElementById('action-log');

    let tasks = [];
    let draggedIndex = null;

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

    addTaskBtn.addEventListener('click', addTask);
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
