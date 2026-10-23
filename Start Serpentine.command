#!/bin/bash
# Double-click to open Serpentine in your browser. Close this window to stop it.
cd "$(dirname "$0")"
PORT=8765
python3 -m http.server $PORT --bind 127.0.0.1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
sleep 1
open "http://127.0.0.1:$PORT/app.html"
echo "Serpentine is running at http://127.0.0.1:$PORT/app.html"
echo "Close this window to stop it."
wait $SERVER
