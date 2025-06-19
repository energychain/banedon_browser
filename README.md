# Banedon Browser

This project provides a web interface for visually following browser automation tasks and building a "receipt" of actions to be executed by a browser extension.

## Features

-   **Task Management**: Add and remove tasks or questions.
-   **Visualizer**: A log panel shows a history of actions taken within the interface. This is a placeholder for future visual feedback from the browser.
-   **Receipt Generation**: Compile the task list into a structured JSON format.
-   **Download Receipt**: Download the generated JSON receipt file. This file is intended to be used by a companion browser extension.

## How to Use

1.  Open `index.html` in a web browser.
2.  Type a task (e.g., "Go to wikipedia.org") into the input field and click "Add Task" or press Enter.
3.  Continue adding tasks to build your automation sequence.
4.  You can remove tasks by clicking the trash can icon next to them.
5.  Once your task list is complete, click "Download Receipt".
6.  A JSON file named `receipt-....json` will be downloaded. This file contains your structured list of tasks.

## Receipt Format

The downloaded receipt is a JSON file with the following structure:

```json
{
  "version": "1.0",
  "createdAt": "2023-10-27T10:00:00.000Z",
  "tasks": [
    {
      "id": 1672531200000,
      "type": "user-question",
      "params": {
        "query": "Go to wikipedia.org"
      }
    },
    {
      "id": 1672531205000,
      "type": "user-question",
      "params": {
        "query": "Search for 'Artificial Intelligence'"
      }
    }
  ]
}
```

This receipt can then be loaded into a browser extension designed to interpret and execute these tasks.

## Future Development

-   Connect to a live browser extension via WebSockets for real-time execution and visual feedback (screenshots, DOM highlights).
-   Implement task reordering (e.g., drag-and-drop).
-   Add more sophisticated task types beyond simple "user-question".
-   Allow editing of existing tasks.