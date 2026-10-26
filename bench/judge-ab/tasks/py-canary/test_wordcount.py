from wordcount import word_count


def test_spacing():
    assert word_count("  the  quick brown   fox ") == 4


if __name__ == "__main__":
    test_spacing()
    print("ok")
