from stats import median


def test_odd():
    assert median([3, 1, 2]) == 2


def test_even():
    assert median([4, 1, 3, 2]) == 2.5


if __name__ == "__main__":
    test_odd()
    test_even()
    print("ok")
