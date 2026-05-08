"""Auth dependency tests — exercise the require_api_key dependency directly."""

import pytest
from fastapi import HTTPException

from inference_service import auth


@pytest.mark.asyncio
async def test_no_api_key_disables_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(auth.settings, "api_key", "")
    # Should not raise even without an Authorization header.
    await auth.require_api_key(authorization=None)


@pytest.mark.asyncio
async def test_missing_header_when_key_required(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(auth.settings, "api_key", "secret")
    with pytest.raises(HTTPException) as exc:
        await auth.require_api_key(authorization=None)
    assert exc.value.status_code == 401


@pytest.mark.asyncio
async def test_wrong_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(auth.settings, "api_key", "secret")
    with pytest.raises(HTTPException) as exc:
        await auth.require_api_key(authorization="Bearer wrong")
    assert exc.value.status_code == 401


@pytest.mark.asyncio
async def test_correct_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(auth.settings, "api_key", "secret")
    await auth.require_api_key(authorization="Bearer secret")


@pytest.mark.asyncio
async def test_consteq_short_circuits_on_length() -> None:
    assert not auth._consteq("a", "abc")
    assert auth._consteq("abc", "abc")
