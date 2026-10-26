from datetime import datetime


def stamp():
    """An ISO 8601 timestamp in UTC, such as 2026-10-27T01:02:03.456789Z."""
    return datetime.utcnow().isoformat() + "Z"
