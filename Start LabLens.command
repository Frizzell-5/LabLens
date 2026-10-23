#!/bin/bash
# Double-click to open LabLens in your browser. Close this window to stop it.
cd "$(dirname "$0")"
PORT=8765
open -a "Brave Browser" "http://127.0.0.1:$PORT/" 2>/dev/null || open "http://127.0.0.1:$PORT/"
python3 -m http.server $PORT --bind 127.0.0.1
