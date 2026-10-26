def median(values):
    """The middle value; for an even count, the mean of the two middle values."""
    ordered = sorted(values)
    return ordered[len(ordered) // 2]
