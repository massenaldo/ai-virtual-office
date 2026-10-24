Open my local AI Virtual Office web application.

1. Run `scripts/vo.sh` from the project root.
2. The script checks whether the application is already responding at http://localhost:5173.
3. If it is not running, the script installs dependencies if needed and starts the Vite server.
4. Open the existing or newly started application in the default browser.
5. If startup fails, inspect `.vo-server.log`, diagnose the issue, and explain the fix.
6. Do not start duplicate servers or overwrite saved layout data.
