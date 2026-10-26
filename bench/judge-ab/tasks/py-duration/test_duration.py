from duration import parse_duration


def test_hours_and_minutes():
    assert parse_duration("1h30m") == 5400


def test_minutes():
    assert parse_duration("45m") == 2700


def test_hours():
    assert parse_duration("2h") == 7200


if __name__ == "__main__":
    test_hours_and_minutes()
    test_minutes()
    test_hours()
    print("ok")
