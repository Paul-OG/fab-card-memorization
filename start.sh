#!/bin/bash
set -e
cd "$(dirname "$0")"

# Create venv if it doesn't exist
if [ ! -d ".venv" ]; then
  echo "Creating virtual environment..."
  python3 -m venv .venv
fi

# Install dependencies into venv
.venv/bin/pip install -r requirements.txt -q

echo ""
echo "  FaB Card Recall Trainer"
echo "  → http://localhost:8000"
echo ""
.venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000
