import re


def parse_duration(text):
    """'1h30m' -> 5400, '45m' -> 2700, '2h' -> 7200 (seconds)."""
    hours = re.search(r"(\d+)h", text)
    if hours:
        return int(hours.group(1)) * 3600
    minutes = re.search(r"(\d+)m", text)
    return int(minutes.group(1)) * 60 if minutes else 0
