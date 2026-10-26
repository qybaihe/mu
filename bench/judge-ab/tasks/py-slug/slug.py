import re


def slugify(text):
    """'  Hello,   World! ' -> 'hello-world'"""
    text = text.strip().lower()
    text = re.sub(r"[^a-z0-9]", "-", text)
    return text
