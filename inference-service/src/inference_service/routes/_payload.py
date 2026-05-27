"""Shared base64-payload validation for binary upload routes.

`/vision-ocr` (image) и `/transcribe` (audio) принимают бинарь как base64
в JSON-теле и применяют один и тот же контроль: строгий декод, отказ на
пустом теле, потолок размера. Выносим в общий helper, чтобы guard был один
(а не копия в каждом роуте, разъезжающаяся со временем).
"""

import base64
import binascii

from fastapi import HTTPException, status


def decode_b64_payload(value: str, *, field: str, max_bytes: int) -> bytes:
    """Декодировать base64-поле и провалидировать. Поднимает HTTPException
    с корректным кодом на каждую ошибку (400 на невалид/пустоту, 413 на
    превышение лимита). `field` — имя поля для понятного текста ошибки."""
    try:
        decoded = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{field} is not valid base64: {e}",
        ) from e

    if len(decoded) == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{field} decoded to zero bytes",
        )
    if len(decoded) > max_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"payload too large: {len(decoded)} bytes (max {max_bytes})",
        )
    return decoded
