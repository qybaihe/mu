from slug import slugify


def test_collapses_runs():
    assert slugify("  Hello,   World! ") == "hello-world"


def test_plain():
    assert slugify("Release Notes 2") == "release-notes-2"


if __name__ == "__main__":
    test_collapses_runs()
    test_plain()
    print("ok")
