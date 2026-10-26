Open my local AI Virtual Office web application.

1. Run `scripts/vo.sh "${CLAUDE_SESSION_ID}"` from the project root. The argument is this Claude Code session's ID.
2. The script checks whether the application is already responding at http://localhost:5173.
3. If it is not running, the script installs dependencies if needed and starts the Vite server.
4. Open the existing or newly started application in the default browser, at `http://localhost:5173/sessionID=<ID>` (this session's ID). Show that link in your reply as a note.
5. A server started by this command stops by itself, immediately, when the last browser page is closed (a page reload also stops it; run `/vo` again).
6. If startup fails, inspect `.vo-server.log`, diagnose the issue, and explain the fix.
7. Do not start duplicate servers or overwrite saved layout data.
