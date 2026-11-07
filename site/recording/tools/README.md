# Recording the home page's terminal replay

`replay-en.json` and `replay-zh.json` are the terminal recording on usemu.dev's home page. Record
them again whenever the welcome screen changes, for example after a release:

```bash
npm i --prefix /tmp/mu-rec mu-agent@latest
site/recording/tools/record.sh en /tmp/mu-rec/node_modules/.bin/mu
site/recording/tools/record.sh zh /tmp/mu-rec/node_modules/.bin/mu
python site/build.py /tmp/site   # fails if the replay lacks a step the page points at
```

- mu runs in tmux at 84x30 in a fresh home, in a copy of `relay/`, a small job-queue project
  whose `m` duration unit is 1,000 ms instead of 60,000; one of its 13 tests fails.
- The judge is real: the free Jev when no judge key is set up.
- The coding model is `mockmodel.py`, an OpenAI-compatible endpoint that answers as
  `xiaomi/mimo-v2.6-pro` with scripted replies: run the tests, read the parser, fix the unit, run
  the tests again, sum up. The tools really run; mu edits the file and the tests pass. The
  model's price is set to zero, so the footer shows no cost. The page says the replies are scripted.
- `recorder.py` follows `../s-play-en.json` or `../s-play.json` (wait, type the prompt, wait
  until the last line of the answer) and keeps a frame whenever the screen changes.
