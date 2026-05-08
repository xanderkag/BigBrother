"""Test fixtures.

The app caches the backend in lifespan + lru_cache; tests skip the lifespan
and exercise routes through Starlette's TestClient with a forced stub
backend so the suite runs without GPU or model downloads.
"""

import os

# Ensure stub backend before importing the app — settings is read at import.
os.environ.setdefault("BACKEND", "stub")
os.environ.setdefault("API_KEY", "")

import pytest
from fastapi.testclient import TestClient

from inference_service.deps import get_backend
from inference_service.main import app


@pytest.fixture(scope="session")
def client() -> TestClient:
    # Eager-init backend, then mount it on app.state — bypasses lifespan,
    # which TestClient runs only when used as a context manager.
    app.state.backend = get_backend()
    return TestClient(app)
