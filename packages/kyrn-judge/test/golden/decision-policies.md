# What each decision does with the judge's answers

Written by `decision-policies.test.ts` from the inputs in `decision-inputs.ts`: the outcome as each answer moves
across its range, the decision's other answers held high (the first option, p 0.95) and then low (the last option,
p 0.05). Do not edit by hand. A section that changes needs a new `version` in its decision; then run the test with
`-u`.

## board.read v5

- `phase` (choice), the others high:
  - understanding: 0.3–0.55 → {"phase":"fixing","focus":"a1","needsUser":false,"update":true,"key":[0,1]}; 0.6–0.99 → {"phase":"understanding","focus":"a1","needsUser":false,"update":true,"key":[0,1]}; without p → {"phase":"understanding","focus":"a1","needsUser":false,"update":true,"key":[0,1]}
  - planning: 0.3–0.55 → {"phase":"fixing","focus":"a1","needsUser":false,"update":true,"key":[0,1]}; 0.6–0.99 → {"phase":"planning","focus":"a1","needsUser":false,"update":true,"key":[0,1]}; without p → {"phase":"planning","focus":"a1","needsUser":false,"update":true,"key":[0,1]}
  - changing: 0.3–0.55 → {"phase":"fixing","focus":"a1","needsUser":false,"update":true,"key":[0,1]}; 0.6–0.99 → {"phase":"changing","focus":"a1","needsUser":false,"update":true,"key":[0,1]}; without p → {"phase":"changing","focus":"a1","needsUser":false,"update":true,"key":[0,1]}
  - checking: 0.3–0.55 → {"phase":"fixing","focus":"a1","needsUser":false,"update":true,"key":[0,1]}; 0.6–0.99 → {"phase":"checking","focus":"a1","needsUser":false,"update":true,"key":[0,1]}; without p → {"phase":"checking","focus":"a1","needsUser":false,"update":true,"key":[0,1]}
  - fixing: 0.3–0.99 → {"phase":"fixing","focus":"a1","needsUser":false,"update":true,"key":[0,1]}; without p → {"phase":"fixing","focus":"a1","needsUser":false,"update":true,"key":[0,1]}
  - waiting: 0.3–0.55 → {"phase":"fixing","focus":"a1","needsUser":false,"update":true,"key":[0,1]}; 0.6–0.99 → {"phase":"waiting","focus":"a1","needsUser":false,"update":true,"key":[0,1]}; without p → {"phase":"waiting","focus":"a1","needsUser":false,"update":true,"key":[0,1]}
  - wrapping_up: 0.3–0.55 → {"phase":"fixing","focus":"a1","needsUser":false,"update":true,"key":[0,1]}; 0.6–0.99 → {"phase":"wrapping_up","focus":"a1","needsUser":false,"update":true,"key":[0,1]}; without p → {"phase":"wrapping_up","focus":"a1","needsUser":false,"update":true,"key":[0,1]}
  - stuck: 0.3–0.55 → {"phase":"fixing","focus":"a1","needsUser":false,"update":true,"key":[0,1]}; 0.6–0.99 → {"phase":"stuck","focus":"a1","needsUser":false,"update":true,"key":[0,1]}; without p → {"phase":"stuck","focus":"a1","needsUser":false,"update":true,"key":[0,1]}
  - blocked: 0.3–0.55 → {"phase":"fixing","focus":"a1","needsUser":false,"update":true,"key":[0,1]}; 0.6–0.99 → {"phase":"blocked","focus":"a1","needsUser":false,"update":true,"key":[0,1]}; without p → {"phase":"blocked","focus":"a1","needsUser":false,"update":true,"key":[0,1]}
  - other: 0.3–0.99 → {"phase":"fixing","focus":"a1","needsUser":false,"update":true,"key":[0,1]}; without p → {"phase":"fixing","focus":"a1","needsUser":false,"update":true,"key":[0,1]}
- `phase` (choice), the others low:
  - understanding: 0.3–0.55 → {"phase":"fixing","focus":null,"needsUser":false,"update":true,"key":[0,1]}; 0.6–0.99 → {"phase":"understanding","focus":null,"needsUser":false,"update":true,"key":[0,1]}; without p → {"phase":"understanding","focus":null,"needsUser":false,"update":true,"key":[0,1]}
  - planning: 0.3–0.55 → {"phase":"fixing","focus":null,"needsUser":false,"update":true,"key":[0,1]}; 0.6–0.99 → {"phase":"planning","focus":null,"needsUser":false,"update":true,"key":[0,1]}; without p → {"phase":"planning","focus":null,"needsUser":false,"update":true,"key":[0,1]}
  - changing: 0.3–0.55 → {"phase":"fixing","focus":null,"needsUser":false,"update":true,"key":[0,1]}; 0.6–0.99 → {"phase":"changing","focus":null,"needsUser":false,"update":true,"key":[0,1]}; without p → {"phase":"changing","focus":null,"needsUser":false,"update":true,"key":[0,1]}
  - checking: 0.3–0.55 → {"phase":"fixing","focus":null,"needsUser":false,"update":true,"key":[0,1]}; 0.6–0.99 → {"phase":"checking","focus":null,"needsUser":false,"update":true,"key":[0,1]}; without p → {"phase":"checking","focus":null,"needsUser":false,"update":true,"key":[0,1]}
  - fixing: 0.3–0.99 → {"phase":"fixing","focus":null,"needsUser":false,"update":true,"key":[0,1]}; without p → {"phase":"fixing","focus":null,"needsUser":false,"update":true,"key":[0,1]}
  - waiting: 0.3–0.55 → {"phase":"fixing","focus":null,"needsUser":false,"update":true,"key":[0,1]}; 0.6–0.99 → {"phase":"waiting","focus":null,"needsUser":false,"update":true,"key":[0,1]}; without p → {"phase":"waiting","focus":null,"needsUser":false,"update":true,"key":[0,1]}
  - wrapping_up: 0.3–0.55 → {"phase":"fixing","focus":null,"needsUser":false,"update":true,"key":[0,1]}; 0.6–0.99 → {"phase":"wrapping_up","focus":null,"needsUser":false,"update":true,"key":[0,1]}; without p → {"phase":"wrapping_up","focus":null,"needsUser":false,"update":true,"key":[0,1]}
  - stuck: 0.3–0.55 → {"phase":"fixing","focus":null,"needsUser":false,"update":true,"key":[0,1]}; 0.6–0.99 → {"phase":"stuck","focus":null,"needsUser":false,"update":true,"key":[0,1]}; without p → {"phase":"stuck","focus":null,"needsUser":false,"update":true,"key":[0,1]}
  - blocked: 0.3–0.55 → {"phase":"fixing","focus":null,"needsUser":false,"update":true,"key":[0,1]}; 0.6–0.99 → {"phase":"blocked","focus":null,"needsUser":false,"update":true,"key":[0,1]}; without p → {"phase":"blocked","focus":null,"needsUser":false,"update":true,"key":[0,1]}
  - other: 0.3–0.99 → {"phase":"fixing","focus":null,"needsUser":false,"update":true,"key":[0,1]}; without p → {"phase":"fixing","focus":null,"needsUser":false,"update":true,"key":[0,1]}
- `focus` (choice), the others high:
  - a1: 0.3–0.55 → {"phase":"understanding","focus":null,"needsUser":false,"update":true,"key":[0,1]}; 0.6–0.99 → {"phase":"understanding","focus":"a1","needsUser":false,"update":true,"key":[0,1]}; without p → {"phase":"understanding","focus":"a1","needsUser":false,"update":true,"key":[0,1]}
  - a2: 0.3–0.55 → {"phase":"understanding","focus":null,"needsUser":false,"update":true,"key":[0,1]}; 0.6–0.99 → {"phase":"understanding","focus":"a2","needsUser":false,"update":true,"key":[0,1]}; without p → {"phase":"understanding","focus":"a2","needsUser":false,"update":true,"key":[0,1]}
  - none: 0.3–0.99 → {"phase":"understanding","focus":null,"needsUser":false,"update":true,"key":[0,1]}; without p → {"phase":"understanding","focus":null,"needsUser":false,"update":true,"key":[0,1]}
- `focus` (choice), the others low:
  - a1: 0.3–0.55 → {"phase":"fixing","focus":null,"needsUser":false,"update":true,"key":[0,1]}; 0.6–0.99 → {"phase":"fixing","focus":"a1","needsUser":false,"update":false,"key":[0,1]}; without p → {"phase":"fixing","focus":"a1","needsUser":false,"update":false,"key":[0,1]}
  - a2: 0.3–0.55 → {"phase":"fixing","focus":null,"needsUser":false,"update":true,"key":[0,1]}; 0.6–0.99 → {"phase":"fixing","focus":"a2","needsUser":false,"update":true,"key":[0,1]}; without p → {"phase":"fixing","focus":"a2","needsUser":false,"update":true,"key":[0,1]}
  - none: 0.3–0.99 → {"phase":"fixing","focus":null,"needsUser":false,"update":true,"key":[0,1]}; without p → {"phase":"fixing","focus":null,"needsUser":false,"update":true,"key":[0,1]}
- `event_0` (choice), the others high:
  - key: 0.3–0.55 → {"phase":"understanding","focus":"a1","needsUser":false,"update":true,"key":[1]}; 0.6–0.99 → {"phase":"understanding","focus":"a1","needsUser":false,"update":true,"key":[0,1]}; without p → {"phase":"understanding","focus":"a1","needsUser":false,"update":true,"key":[0,1]}
  - routine: 0.3–0.99 → {"phase":"understanding","focus":"a1","needsUser":false,"update":true,"key":[1]}; without p → {"phase":"understanding","focus":"a1","needsUser":false,"update":true,"key":[1]}
  - unclear: 0.3–0.99 → {"phase":"understanding","focus":"a1","needsUser":false,"update":true,"key":[1]}; without p → {"phase":"understanding","focus":"a1","needsUser":false,"update":true,"key":[1]}
- `event_0` (choice), the others low:
  - key: 0.3–0.55 → {"phase":"fixing","focus":null,"needsUser":false,"update":true,"key":[0,1]}; 0.6–0.99 → {"phase":"fixing","focus":null,"needsUser":false,"update":true,"key":[0]}; without p → {"phase":"fixing","focus":null,"needsUser":false,"update":true,"key":[0]}
  - routine: 0.3–0.55 → {"phase":"fixing","focus":null,"needsUser":false,"update":true,"key":[0,1]}; 0.6–0.99 → {"phase":"fixing","focus":null,"needsUser":false,"update":true,"key":[]}; without p → {"phase":"fixing","focus":null,"needsUser":false,"update":true,"key":[]}
  - unclear: 0.3–0.99 → {"phase":"fixing","focus":null,"needsUser":false,"update":true,"key":[0,1]}; without p → {"phase":"fixing","focus":null,"needsUser":false,"update":true,"key":[0,1]}
- `event_1` (choice), the others high:
  - key: 0.3–0.55 → {"phase":"understanding","focus":"a1","needsUser":false,"update":true,"key":[0]}; 0.6–0.99 → {"phase":"understanding","focus":"a1","needsUser":false,"update":true,"key":[0,1]}; without p → {"phase":"understanding","focus":"a1","needsUser":false,"update":true,"key":[0,1]}
  - routine: 0.3–0.99 → {"phase":"understanding","focus":"a1","needsUser":false,"update":true,"key":[0]}; without p → {"phase":"understanding","focus":"a1","needsUser":false,"update":true,"key":[0]}
  - unclear: 0.3–0.99 → {"phase":"understanding","focus":"a1","needsUser":false,"update":true,"key":[0]}; without p → {"phase":"understanding","focus":"a1","needsUser":false,"update":true,"key":[0]}
- `event_1` (choice), the others low:
  - key: 0.3–0.55 → {"phase":"fixing","focus":null,"needsUser":false,"update":true,"key":[0,1]}; 0.6–0.99 → {"phase":"fixing","focus":null,"needsUser":false,"update":true,"key":[1]}; without p → {"phase":"fixing","focus":null,"needsUser":false,"update":true,"key":[1]}
  - routine: 0.3–0.55 → {"phase":"fixing","focus":null,"needsUser":false,"update":true,"key":[0,1]}; 0.6–0.99 → {"phase":"fixing","focus":null,"needsUser":false,"update":true,"key":[]}; without p → {"phase":"fixing","focus":null,"needsUser":false,"update":true,"key":[]}
  - unclear: 0.3–0.99 → {"phase":"fixing","focus":null,"needsUser":false,"update":true,"key":[0,1]}; without p → {"phase":"fixing","focus":null,"needsUser":false,"update":true,"key":[0,1]}
- `changed` (boolean), the others high:
  - p(true): 0.01–0.99 → {"phase":"understanding","focus":"a1","needsUser":false,"update":true,"key":[0,1]}
- `changed` (boolean), the others low:
  - p(true): 0.01–0.99 → {"phase":"fixing","focus":null,"needsUser":false,"update":true,"key":[0,1]}
- no answer: {"phase":"fixing","focus":null,"needsUser":false,"update":true,"key":[0,1]}
- the judge failed: {"phase":"fixing","focus":null,"needsUser":false,"update":true,"key":[0,1]} (fallback)

## browser.step v1

- `operation` (choice), the others high:
  - CLICK: 0.3–0.99 → {"operation":"CLICK","target":"2","probability":0.95}; without p → {"operation":"CLICK","target":"2","probability":0.95}
  - TYPE_TEXT: 0.3–0.99 → {"operation":"TYPE_TEXT","target":"1","probability":0.95}; without p → {"operation":"TYPE_TEXT","target":"1","probability":0.95}
  - SCROLL_DOWN: 0.3 → {"operation":"SCROLL_DOWN","target":null,"probability":0.3}; 0.4 → {"operation":"SCROLL_DOWN","target":null,"probability":0.4}; 0.5 → {"operation":"SCROLL_DOWN","target":null,"probability":0.5}; 0.55 → {"operation":"SCROLL_DOWN","target":null,"probability":0.55}; 0.6 → {"operation":"SCROLL_DOWN","target":null,"probability":0.6}; 0.65 → {"operation":"SCROLL_DOWN","target":null,"probability":0.65}; 0.7 → {"operation":"SCROLL_DOWN","target":null,"probability":0.7}; 0.75 → {"operation":"SCROLL_DOWN","target":null,"probability":0.75}; 0.8 → {"operation":"SCROLL_DOWN","target":null,"probability":0.8}; 0.85 → {"operation":"SCROLL_DOWN","target":null,"probability":0.85}; 0.9 → {"operation":"SCROLL_DOWN","target":null,"probability":0.9}; 0.95 → {"operation":"SCROLL_DOWN","target":null,"probability":0.95}; 0.99 → {"operation":"SCROLL_DOWN","target":null,"probability":0.99}; without p → {"operation":"SCROLL_DOWN","target":null,"probability":null}
  - WAIT: 0.3 → {"operation":"WAIT","target":null,"probability":0.3}; 0.4 → {"operation":"WAIT","target":null,"probability":0.4}; 0.5 → {"operation":"WAIT","target":null,"probability":0.5}; 0.55 → {"operation":"WAIT","target":null,"probability":0.55}; 0.6 → {"operation":"WAIT","target":null,"probability":0.6}; 0.65 → {"operation":"WAIT","target":null,"probability":0.65}; 0.7 → {"operation":"WAIT","target":null,"probability":0.7}; 0.75 → {"operation":"WAIT","target":null,"probability":0.75}; 0.8 → {"operation":"WAIT","target":null,"probability":0.8}; 0.85 → {"operation":"WAIT","target":null,"probability":0.85}; 0.9 → {"operation":"WAIT","target":null,"probability":0.9}; 0.95 → {"operation":"WAIT","target":null,"probability":0.95}; 0.99 → {"operation":"WAIT","target":null,"probability":0.99}; without p → {"operation":"WAIT","target":null,"probability":null}
  - DONE: 0.3 → {"operation":"DONE","target":null,"probability":0.3}; 0.4 → {"operation":"DONE","target":null,"probability":0.4}; 0.5 → {"operation":"DONE","target":null,"probability":0.5}; 0.55 → {"operation":"DONE","target":null,"probability":0.55}; 0.6 → {"operation":"DONE","target":null,"probability":0.6}; 0.65 → {"operation":"DONE","target":null,"probability":0.65}; 0.7 → {"operation":"DONE","target":null,"probability":0.7}; 0.75 → {"operation":"DONE","target":null,"probability":0.75}; 0.8 → {"operation":"DONE","target":null,"probability":0.8}; 0.85 → {"operation":"DONE","target":null,"probability":0.85}; 0.9 → {"operation":"DONE","target":null,"probability":0.9}; 0.95 → {"operation":"DONE","target":null,"probability":0.95}; 0.99 → {"operation":"DONE","target":null,"probability":0.99}; without p → {"operation":"DONE","target":null,"probability":null}
  - other: 0.3–0.99 → {"operation":"BLOCKED","target":null,"probability":null}; without p → {"operation":"BLOCKED","target":null,"probability":null}
- `operation` (choice), the others low:
  - CLICK: 0.3 → {"operation":"CLICK","target":null,"probability":0.3}; 0.4 → {"operation":"CLICK","target":null,"probability":0.4}; 0.5 → {"operation":"CLICK","target":null,"probability":0.5}; 0.55 → {"operation":"CLICK","target":null,"probability":0.55}; 0.6 → {"operation":"CLICK","target":null,"probability":0.6}; 0.65 → {"operation":"CLICK","target":null,"probability":0.65}; 0.7 → {"operation":"CLICK","target":null,"probability":0.7}; 0.75 → {"operation":"CLICK","target":null,"probability":0.75}; 0.8 → {"operation":"CLICK","target":null,"probability":0.8}; 0.85 → {"operation":"CLICK","target":null,"probability":0.85}; 0.9 → {"operation":"CLICK","target":null,"probability":0.9}; 0.95 → {"operation":"CLICK","target":null,"probability":0.95}; 0.99 → {"operation":"CLICK","target":null,"probability":0.99}; without p → {"operation":"CLICK","target":null,"probability":null}
  - TYPE_TEXT: 0.3 → {"operation":"TYPE_TEXT","target":null,"probability":0.3}; 0.4 → {"operation":"TYPE_TEXT","target":null,"probability":0.4}; 0.5 → {"operation":"TYPE_TEXT","target":null,"probability":0.5}; 0.55 → {"operation":"TYPE_TEXT","target":null,"probability":0.55}; 0.6 → {"operation":"TYPE_TEXT","target":null,"probability":0.6}; 0.65 → {"operation":"TYPE_TEXT","target":null,"probability":0.65}; 0.7 → {"operation":"TYPE_TEXT","target":null,"probability":0.7}; 0.75 → {"operation":"TYPE_TEXT","target":null,"probability":0.75}; 0.8 → {"operation":"TYPE_TEXT","target":null,"probability":0.8}; 0.85 → {"operation":"TYPE_TEXT","target":null,"probability":0.85}; 0.9 → {"operation":"TYPE_TEXT","target":null,"probability":0.9}; 0.95 → {"operation":"TYPE_TEXT","target":null,"probability":0.95}; 0.99 → {"operation":"TYPE_TEXT","target":null,"probability":0.99}; without p → {"operation":"TYPE_TEXT","target":null,"probability":null}
  - SCROLL_DOWN: 0.3 → {"operation":"SCROLL_DOWN","target":null,"probability":0.3}; 0.4 → {"operation":"SCROLL_DOWN","target":null,"probability":0.4}; 0.5 → {"operation":"SCROLL_DOWN","target":null,"probability":0.5}; 0.55 → {"operation":"SCROLL_DOWN","target":null,"probability":0.55}; 0.6 → {"operation":"SCROLL_DOWN","target":null,"probability":0.6}; 0.65 → {"operation":"SCROLL_DOWN","target":null,"probability":0.65}; 0.7 → {"operation":"SCROLL_DOWN","target":null,"probability":0.7}; 0.75 → {"operation":"SCROLL_DOWN","target":null,"probability":0.75}; 0.8 → {"operation":"SCROLL_DOWN","target":null,"probability":0.8}; 0.85 → {"operation":"SCROLL_DOWN","target":null,"probability":0.85}; 0.9 → {"operation":"SCROLL_DOWN","target":null,"probability":0.9}; 0.95 → {"operation":"SCROLL_DOWN","target":null,"probability":0.95}; 0.99 → {"operation":"SCROLL_DOWN","target":null,"probability":0.99}; without p → {"operation":"SCROLL_DOWN","target":null,"probability":null}
  - WAIT: 0.3 → {"operation":"WAIT","target":null,"probability":0.3}; 0.4 → {"operation":"WAIT","target":null,"probability":0.4}; 0.5 → {"operation":"WAIT","target":null,"probability":0.5}; 0.55 → {"operation":"WAIT","target":null,"probability":0.55}; 0.6 → {"operation":"WAIT","target":null,"probability":0.6}; 0.65 → {"operation":"WAIT","target":null,"probability":0.65}; 0.7 → {"operation":"WAIT","target":null,"probability":0.7}; 0.75 → {"operation":"WAIT","target":null,"probability":0.75}; 0.8 → {"operation":"WAIT","target":null,"probability":0.8}; 0.85 → {"operation":"WAIT","target":null,"probability":0.85}; 0.9 → {"operation":"WAIT","target":null,"probability":0.9}; 0.95 → {"operation":"WAIT","target":null,"probability":0.95}; 0.99 → {"operation":"WAIT","target":null,"probability":0.99}; without p → {"operation":"WAIT","target":null,"probability":null}
  - DONE: 0.3 → {"operation":"DONE","target":null,"probability":0.3}; 0.4 → {"operation":"DONE","target":null,"probability":0.4}; 0.5 → {"operation":"DONE","target":null,"probability":0.5}; 0.55 → {"operation":"DONE","target":null,"probability":0.55}; 0.6 → {"operation":"DONE","target":null,"probability":0.6}; 0.65 → {"operation":"DONE","target":null,"probability":0.65}; 0.7 → {"operation":"DONE","target":null,"probability":0.7}; 0.75 → {"operation":"DONE","target":null,"probability":0.75}; 0.8 → {"operation":"DONE","target":null,"probability":0.8}; 0.85 → {"operation":"DONE","target":null,"probability":0.85}; 0.9 → {"operation":"DONE","target":null,"probability":0.9}; 0.95 → {"operation":"DONE","target":null,"probability":0.95}; 0.99 → {"operation":"DONE","target":null,"probability":0.99}; without p → {"operation":"DONE","target":null,"probability":null}
  - other: 0.3–0.99 → {"operation":"BLOCKED","target":null,"probability":null}; without p → {"operation":"BLOCKED","target":null,"probability":null}
- `click_target` (choice), the others high:
  - 2: 0.3 → {"operation":"CLICK","target":"2","probability":0.3}; 0.4 → {"operation":"CLICK","target":"2","probability":0.4}; 0.5 → {"operation":"CLICK","target":"2","probability":0.5}; 0.55 → {"operation":"CLICK","target":"2","probability":0.55}; 0.6 → {"operation":"CLICK","target":"2","probability":0.6}; 0.65 → {"operation":"CLICK","target":"2","probability":0.65}; 0.7 → {"operation":"CLICK","target":"2","probability":0.7}; 0.75 → {"operation":"CLICK","target":"2","probability":0.75}; 0.8 → {"operation":"CLICK","target":"2","probability":0.8}; 0.85 → {"operation":"CLICK","target":"2","probability":0.85}; 0.9 → {"operation":"CLICK","target":"2","probability":0.9}; 0.95 → {"operation":"CLICK","target":"2","probability":0.95}; 0.99 → {"operation":"CLICK","target":"2","probability":0.99}; without p → {"operation":"CLICK","target":"2","probability":null}
  - none: 0.3–0.99 → {"operation":"CLICK","target":null,"probability":0.95}; without p → {"operation":"CLICK","target":null,"probability":0.95}
- `click_target` (choice), the others low:
  - 2: 0.3–0.99 → {"operation":"BLOCKED","target":null,"probability":null}; without p → {"operation":"BLOCKED","target":null,"probability":null}
  - none: 0.3–0.99 → {"operation":"BLOCKED","target":null,"probability":null}; without p → {"operation":"BLOCKED","target":null,"probability":null}
- `type_text_target` (choice), the others high:
  - 1: 0.3–0.99 → {"operation":"CLICK","target":"2","probability":0.95}; without p → {"operation":"CLICK","target":"2","probability":0.95}
  - none: 0.3–0.99 → {"operation":"CLICK","target":"2","probability":0.95}; without p → {"operation":"CLICK","target":"2","probability":0.95}
- `type_text_target` (choice), the others low:
  - 1: 0.3–0.99 → {"operation":"BLOCKED","target":null,"probability":null}; without p → {"operation":"BLOCKED","target":null,"probability":null}
  - none: 0.3–0.99 → {"operation":"BLOCKED","target":null,"probability":null}; without p → {"operation":"BLOCKED","target":null,"probability":null}
- no answer: {"operation":"BLOCKED","target":null,"probability":null} (fallback)
- the judge failed: {"operation":"BLOCKED","target":null,"probability":null} (fallback)

## cache.warming v1

- `finished` (boolean), the others high:
  - p(true): 0.01–0.99 → "warm"
- `finished` (boolean), the others low:
  - p(true): 0.01–0.75 → "default"; 0.8–0.99 → "stop"
- `open` (boolean), the others high:
  - p(true): 0.01–0.75 → "stop"; 0.8–0.99 → "warm"
- `open` (boolean), the others low:
  - p(true): 0.01–0.75 → "default"; 0.8–0.99 → "warm"
- no answer: "default" (fallback)
- the judge failed: "default" (fallback)

## capability.disclosure v1

- `capability_0` (boolean), the others high:
  - p(true): 0.01–0.75 → {"open":["github"]}; 0.8–0.99 → {"open":["debugger","github"]}
- `capability_0` (boolean), the others low:
  - p(true): 0.01–0.75 → {"open":[]}; 0.8–0.99 → {"open":["debugger"]}
- `capability_1` (boolean), the others high:
  - p(true): 0.01–0.75 → {"open":["debugger"]}; 0.8–0.99 → {"open":["debugger","github"]}
- `capability_1` (boolean), the others low:
  - p(true): 0.01–0.75 → {"open":[]}; 0.8–0.99 → {"open":["github"]}
- no answer: {"open":[]}
- the judge failed: {"open":[]} (fallback)

## context.compact v1

- `kind` (choice), the others high:
  - error: 0.3–0.4 → {"kind":null,"keepResult":0.95,"keepCall":0.95}; 0.5–0.99 → {"kind":"error","keepResult":0.95,"keepCall":0.95}; without p → {"kind":"error","keepResult":0.95,"keepCall":0.95}
  - listing: 0.3–0.4 → {"kind":null,"keepResult":0.95,"keepCall":0.95}; 0.5–0.99 → {"kind":"listing","keepResult":0.95,"keepCall":0.95}; without p → {"kind":"listing","keepResult":0.95,"keepCall":0.95}
  - content: 0.3–0.4 → {"kind":null,"keepResult":0.95,"keepCall":0.95}; 0.5–0.99 → {"kind":"content","keepResult":0.95,"keepCall":0.95}; without p → {"kind":"content","keepResult":0.95,"keepCall":0.95}
  - log: 0.3–0.4 → {"kind":null,"keepResult":0.95,"keepCall":0.95}; 0.5–0.99 → {"kind":"log","keepResult":0.95,"keepCall":0.95}; without p → {"kind":"log","keepResult":0.95,"keepCall":0.95}
  - data: 0.3–0.4 → {"kind":null,"keepResult":0.95,"keepCall":0.95}; 0.5–0.99 → {"kind":"data","keepResult":0.95,"keepCall":0.95}; without p → {"kind":"data","keepResult":0.95,"keepCall":0.95}
  - other: 0.3–0.99 → {"kind":null,"keepResult":0.95,"keepCall":0.95}; without p → {"kind":null,"keepResult":0.95,"keepCall":0.95}
- `kind` (choice), the others low:
  - error: 0.3–0.4 → {"kind":null,"keepResult":0.05,"keepCall":0.05}; 0.5–0.99 → {"kind":"error","keepResult":0.05,"keepCall":0.05}; without p → {"kind":"error","keepResult":0.05,"keepCall":0.05}
  - listing: 0.3–0.4 → {"kind":null,"keepResult":0.05,"keepCall":0.05}; 0.5–0.99 → {"kind":"listing","keepResult":0.05,"keepCall":0.05}; without p → {"kind":"listing","keepResult":0.05,"keepCall":0.05}
  - content: 0.3–0.4 → {"kind":null,"keepResult":0.05,"keepCall":0.05}; 0.5–0.99 → {"kind":"content","keepResult":0.05,"keepCall":0.05}; without p → {"kind":"content","keepResult":0.05,"keepCall":0.05}
  - log: 0.3–0.4 → {"kind":null,"keepResult":0.05,"keepCall":0.05}; 0.5–0.99 → {"kind":"log","keepResult":0.05,"keepCall":0.05}; without p → {"kind":"log","keepResult":0.05,"keepCall":0.05}
  - data: 0.3–0.4 → {"kind":null,"keepResult":0.05,"keepCall":0.05}; 0.5–0.99 → {"kind":"data","keepResult":0.05,"keepCall":0.05}; without p → {"kind":"data","keepResult":0.05,"keepCall":0.05}
  - other: 0.3–0.99 → {"kind":null,"keepResult":0.05,"keepCall":0.05}; without p → {"kind":null,"keepResult":0.05,"keepCall":0.05}
- `result_needed` (boolean), the others high:
  - p(true): 0.01 → {"kind":"error","keepResult":0.01,"keepCall":0.95}; 0.1 → {"kind":"error","keepResult":0.1,"keepCall":0.95}; 0.2 → {"kind":"error","keepResult":0.2,"keepCall":0.95}; 0.3 → {"kind":"error","keepResult":0.3,"keepCall":0.95}; 0.4 → {"kind":"error","keepResult":0.4,"keepCall":0.95}; 0.5 → {"kind":"error","keepResult":0.5,"keepCall":0.95}; 0.55 → {"kind":"error","keepResult":0.55,"keepCall":0.95}; 0.6 → {"kind":"error","keepResult":0.6,"keepCall":0.95}; 0.65 → {"kind":"error","keepResult":0.65,"keepCall":0.95}; 0.7 → {"kind":"error","keepResult":0.7,"keepCall":0.95}; 0.75 → {"kind":"error","keepResult":0.75,"keepCall":0.95}; 0.8 → {"kind":"error","keepResult":0.8,"keepCall":0.95}; 0.85 → {"kind":"error","keepResult":0.85,"keepCall":0.95}; 0.9 → {"kind":"error","keepResult":0.9,"keepCall":0.95}; 0.95 → {"kind":"error","keepResult":0.95,"keepCall":0.95}; 0.99 → {"kind":"error","keepResult":0.99,"keepCall":0.95}
- `result_needed` (boolean), the others low:
  - p(true): 0.01 → {"kind":null,"keepResult":0.01,"keepCall":0.05}; 0.1 → {"kind":null,"keepResult":0.1,"keepCall":0.05}; 0.2 → {"kind":null,"keepResult":0.2,"keepCall":0.05}; 0.3 → {"kind":null,"keepResult":0.3,"keepCall":0.05}; 0.4 → {"kind":null,"keepResult":0.4,"keepCall":0.05}; 0.5 → {"kind":null,"keepResult":0.5,"keepCall":0.05}; 0.55 → {"kind":null,"keepResult":0.55,"keepCall":0.05}; 0.6 → {"kind":null,"keepResult":0.6,"keepCall":0.05}; 0.65 → {"kind":null,"keepResult":0.65,"keepCall":0.05}; 0.7 → {"kind":null,"keepResult":0.7,"keepCall":0.05}; 0.75 → {"kind":null,"keepResult":0.75,"keepCall":0.05}; 0.8 → {"kind":null,"keepResult":0.8,"keepCall":0.05}; 0.85 → {"kind":null,"keepResult":0.85,"keepCall":0.05}; 0.9 → {"kind":null,"keepResult":0.9,"keepCall":0.05}; 0.95 → {"kind":null,"keepResult":0.95,"keepCall":0.05}; 0.99 → {"kind":null,"keepResult":0.99,"keepCall":0.05}
- `call_matters` (boolean), the others high:
  - p(true): 0.01 → {"kind":"error","keepResult":0.95,"keepCall":0.01}; 0.1 → {"kind":"error","keepResult":0.95,"keepCall":0.1}; 0.2 → {"kind":"error","keepResult":0.95,"keepCall":0.2}; 0.3 → {"kind":"error","keepResult":0.95,"keepCall":0.3}; 0.4 → {"kind":"error","keepResult":0.95,"keepCall":0.4}; 0.5 → {"kind":"error","keepResult":0.95,"keepCall":0.5}; 0.55 → {"kind":"error","keepResult":0.95,"keepCall":0.55}; 0.6 → {"kind":"error","keepResult":0.95,"keepCall":0.6}; 0.65 → {"kind":"error","keepResult":0.95,"keepCall":0.65}; 0.7 → {"kind":"error","keepResult":0.95,"keepCall":0.7}; 0.75 → {"kind":"error","keepResult":0.95,"keepCall":0.75}; 0.8 → {"kind":"error","keepResult":0.95,"keepCall":0.8}; 0.85 → {"kind":"error","keepResult":0.95,"keepCall":0.85}; 0.9 → {"kind":"error","keepResult":0.95,"keepCall":0.9}; 0.95 → {"kind":"error","keepResult":0.95,"keepCall":0.95}; 0.99 → {"kind":"error","keepResult":0.95,"keepCall":0.99}
- `call_matters` (boolean), the others low:
  - p(true): 0.01 → {"kind":null,"keepResult":0.05,"keepCall":0.01}; 0.1 → {"kind":null,"keepResult":0.05,"keepCall":0.1}; 0.2 → {"kind":null,"keepResult":0.05,"keepCall":0.2}; 0.3 → {"kind":null,"keepResult":0.05,"keepCall":0.3}; 0.4 → {"kind":null,"keepResult":0.05,"keepCall":0.4}; 0.5 → {"kind":null,"keepResult":0.05,"keepCall":0.5}; 0.55 → {"kind":null,"keepResult":0.05,"keepCall":0.55}; 0.6 → {"kind":null,"keepResult":0.05,"keepCall":0.6}; 0.65 → {"kind":null,"keepResult":0.05,"keepCall":0.65}; 0.7 → {"kind":null,"keepResult":0.05,"keepCall":0.7}; 0.75 → {"kind":null,"keepResult":0.05,"keepCall":0.75}; 0.8 → {"kind":null,"keepResult":0.05,"keepCall":0.8}; 0.85 → {"kind":null,"keepResult":0.05,"keepCall":0.85}; 0.9 → {"kind":null,"keepResult":0.05,"keepCall":0.9}; 0.95 → {"kind":null,"keepResult":0.05,"keepCall":0.95}; 0.99 → {"kind":null,"keepResult":0.05,"keepCall":0.99}
- no answer: {"kind":null,"keepResult":null,"keepCall":null}
- the judge failed: {"kind":null,"keepResult":null,"keepCall":null} (fallback)

## context.forget v1

- `still_needed` (boolean):
  - p(true): 0.01–0.2 → "shrink"; 0.3–0.99 → "keep"
- no answer: "keep" (fallback)
- the judge failed: "keep" (fallback)

## diagnostics.delivery v1

- `more_edits_coming` (boolean), the others high:
  - p(true): 0.01–0.2 → {"errors":"now","warnings":"drop"}; 0.3–0.75 → {"errors":"hold","warnings":"drop"} (fallback); 0.8–0.99 → {"errors":"now","warnings":"drop"}
- `more_edits_coming` (boolean), the others low:
  - p(true): 0.01–0.2 → {"errors":"now","warnings":"now"}; 0.3–0.75 → {"errors":"hold","warnings":"drop"} (fallback); 0.8–0.99 → {"errors":"now","warnings":"now"}
- `warnings_are_style` (boolean), the others high:
  - p(true): 0.01–0.2 → {"errors":"now","warnings":"now"}; 0.3–0.75 → {"errors":"now","warnings":"hold"}; 0.8–0.99 → {"errors":"now","warnings":"drop"}
- `warnings_are_style` (boolean), the others low:
  - p(true): 0.01–0.2 → {"errors":"now","warnings":"now"}; 0.3–0.75 → {"errors":"now","warnings":"hold"}; 0.8–0.99 → {"errors":"now","warnings":"drop"}
- no answer: {"errors":"hold","warnings":"drop"} (fallback)
- the judge failed: {"errors":"hold","warnings":"drop"} (fallback)

## files.locate v1

- `path_0` (boolean), the others high:
  - p(true): 0.01 → {"ranked":[{"path":"/work/project/src/format.ts","probability":0.95},{"path":"/work/project/src/parse.ts","probability":0.01}]}; 0.1 → {"ranked":[{"path":"/work/project/src/format.ts","probability":0.95},{"path":"/work/project/src/parse.ts","probability":0.1}]}; 0.2 → {"ranked":[{"path":"/work/project/src/format.ts","probability":0.95},{"path":"/work/project/src/parse.ts","probability":0.2}]}; 0.3 → {"ranked":[{"path":"/work/project/src/format.ts","probability":0.95},{"path":"/work/project/src/parse.ts","probability":0.3}]}; 0.4 → {"ranked":[{"path":"/work/project/src/format.ts","probability":0.95},{"path":"/work/project/src/parse.ts","probability":0.4}]}; 0.5 → {"ranked":[{"path":"/work/project/src/format.ts","probability":0.95},{"path":"/work/project/src/parse.ts","probability":0.5}]}; 0.55 → {"ranked":[{"path":"/work/project/src/format.ts","probability":0.95},{"path":"/work/project/src/parse.ts","probability":0.55}]}; 0.6 → {"ranked":[{"path":"/work/project/src/format.ts","probability":0.95},{"path":"/work/project/src/parse.ts","probability":0.6}]}; 0.65 → {"ranked":[{"path":"/work/project/src/format.ts","probability":0.95},{"path":"/work/project/src/parse.ts","probability":0.65}]}; 0.7 → {"ranked":[{"path":"/work/project/src/format.ts","probability":0.95},{"path":"/work/project/src/parse.ts","probability":0.7}]}; 0.75 → {"ranked":[{"path":"/work/project/src/format.ts","probability":0.95},{"path":"/work/project/src/parse.ts","probability":0.75}]}; 0.8 → {"ranked":[{"path":"/work/project/src/format.ts","probability":0.95},{"path":"/work/project/src/parse.ts","probability":0.8}]}; 0.85 → {"ranked":[{"path":"/work/project/src/format.ts","probability":0.95},{"path":"/work/project/src/parse.ts","probability":0.85}]}; 0.9 → {"ranked":[{"path":"/work/project/src/format.ts","probability":0.95},{"path":"/work/project/src/parse.ts","probability":0.9}]}; 0.95 → {"ranked":[{"path":"/work/project/src/parse.ts","probability":0.95},{"path":"/work/project/src/format.ts","probability":0.95}]}; 0.99 → {"ranked":[{"path":"/work/project/src/parse.ts","probability":0.99},{"path":"/work/project/src/format.ts","probability":0.95}]}
- `path_0` (boolean), the others low:
  - p(true): 0.01 → {"ranked":[{"path":"/work/project/src/format.ts","probability":0.05},{"path":"/work/project/src/parse.ts","probability":0.01}]}; 0.1 → {"ranked":[{"path":"/work/project/src/parse.ts","probability":0.1},{"path":"/work/project/src/format.ts","probability":0.05}]}; 0.2 → {"ranked":[{"path":"/work/project/src/parse.ts","probability":0.2},{"path":"/work/project/src/format.ts","probability":0.05}]}; 0.3 → {"ranked":[{"path":"/work/project/src/parse.ts","probability":0.3},{"path":"/work/project/src/format.ts","probability":0.05}]}; 0.4 → {"ranked":[{"path":"/work/project/src/parse.ts","probability":0.4},{"path":"/work/project/src/format.ts","probability":0.05}]}; 0.5 → {"ranked":[{"path":"/work/project/src/parse.ts","probability":0.5},{"path":"/work/project/src/format.ts","probability":0.05}]}; 0.55 → {"ranked":[{"path":"/work/project/src/parse.ts","probability":0.55},{"path":"/work/project/src/format.ts","probability":0.05}]}; 0.6 → {"ranked":[{"path":"/work/project/src/parse.ts","probability":0.6},{"path":"/work/project/src/format.ts","probability":0.05}]}; 0.65 → {"ranked":[{"path":"/work/project/src/parse.ts","probability":0.65},{"path":"/work/project/src/format.ts","probability":0.05}]}; 0.7 → {"ranked":[{"path":"/work/project/src/parse.ts","probability":0.7},{"path":"/work/project/src/format.ts","probability":0.05}]}; 0.75 → {"ranked":[{"path":"/work/project/src/parse.ts","probability":0.75},{"path":"/work/project/src/format.ts","probability":0.05}]}; 0.8 → {"ranked":[{"path":"/work/project/src/parse.ts","probability":0.8},{"path":"/work/project/src/format.ts","probability":0.05}]}; 0.85 → {"ranked":[{"path":"/work/project/src/parse.ts","probability":0.85},{"path":"/work/project/src/format.ts","probability":0.05}]}; 0.9 → {"ranked":[{"path":"/work/project/src/parse.ts","probability":0.9},{"path":"/work/project/src/format.ts","probability":0.05}]}; 0.95 → {"ranked":[{"path":"/work/project/src/parse.ts","probability":0.95},{"path":"/work/project/src/format.ts","probability":0.05}]}; 0.99 → {"ranked":[{"path":"/work/project/src/parse.ts","probability":0.99},{"path":"/work/project/src/format.ts","probability":0.05}]}
- `path_1` (boolean), the others high:
  - p(true): 0.01 → {"ranked":[{"path":"/work/project/src/parse.ts","probability":0.95},{"path":"/work/project/src/format.ts","probability":0.01}]}; 0.1 → {"ranked":[{"path":"/work/project/src/parse.ts","probability":0.95},{"path":"/work/project/src/format.ts","probability":0.1}]}; 0.2 → {"ranked":[{"path":"/work/project/src/parse.ts","probability":0.95},{"path":"/work/project/src/format.ts","probability":0.2}]}; 0.3 → {"ranked":[{"path":"/work/project/src/parse.ts","probability":0.95},{"path":"/work/project/src/format.ts","probability":0.3}]}; 0.4 → {"ranked":[{"path":"/work/project/src/parse.ts","probability":0.95},{"path":"/work/project/src/format.ts","probability":0.4}]}; 0.5 → {"ranked":[{"path":"/work/project/src/parse.ts","probability":0.95},{"path":"/work/project/src/format.ts","probability":0.5}]}; 0.55 → {"ranked":[{"path":"/work/project/src/parse.ts","probability":0.95},{"path":"/work/project/src/format.ts","probability":0.55}]}; 0.6 → {"ranked":[{"path":"/work/project/src/parse.ts","probability":0.95},{"path":"/work/project/src/format.ts","probability":0.6}]}; 0.65 → {"ranked":[{"path":"/work/project/src/parse.ts","probability":0.95},{"path":"/work/project/src/format.ts","probability":0.65}]}; 0.7 → {"ranked":[{"path":"/work/project/src/parse.ts","probability":0.95},{"path":"/work/project/src/format.ts","probability":0.7}]}; 0.75 → {"ranked":[{"path":"/work/project/src/parse.ts","probability":0.95},{"path":"/work/project/src/format.ts","probability":0.75}]}; 0.8 → {"ranked":[{"path":"/work/project/src/parse.ts","probability":0.95},{"path":"/work/project/src/format.ts","probability":0.8}]}; 0.85 → {"ranked":[{"path":"/work/project/src/parse.ts","probability":0.95},{"path":"/work/project/src/format.ts","probability":0.85}]}; 0.9 → {"ranked":[{"path":"/work/project/src/parse.ts","probability":0.95},{"path":"/work/project/src/format.ts","probability":0.9}]}; 0.95 → {"ranked":[{"path":"/work/project/src/parse.ts","probability":0.95},{"path":"/work/project/src/format.ts","probability":0.95}]}; 0.99 → {"ranked":[{"path":"/work/project/src/format.ts","probability":0.99},{"path":"/work/project/src/parse.ts","probability":0.95}]}
- `path_1` (boolean), the others low:
  - p(true): 0.01 → {"ranked":[{"path":"/work/project/src/parse.ts","probability":0.05},{"path":"/work/project/src/format.ts","probability":0.01}]}; 0.1 → {"ranked":[{"path":"/work/project/src/format.ts","probability":0.1},{"path":"/work/project/src/parse.ts","probability":0.05}]}; 0.2 → {"ranked":[{"path":"/work/project/src/format.ts","probability":0.2},{"path":"/work/project/src/parse.ts","probability":0.05}]}; 0.3 → {"ranked":[{"path":"/work/project/src/format.ts","probability":0.3},{"path":"/work/project/src/parse.ts","probability":0.05}]}; 0.4 → {"ranked":[{"path":"/work/project/src/format.ts","probability":0.4},{"path":"/work/project/src/parse.ts","probability":0.05}]}; 0.5 → {"ranked":[{"path":"/work/project/src/format.ts","probability":0.5},{"path":"/work/project/src/parse.ts","probability":0.05}]}; 0.55 → {"ranked":[{"path":"/work/project/src/format.ts","probability":0.55},{"path":"/work/project/src/parse.ts","probability":0.05}]}; 0.6 → {"ranked":[{"path":"/work/project/src/format.ts","probability":0.6},{"path":"/work/project/src/parse.ts","probability":0.05}]}; 0.65 → {"ranked":[{"path":"/work/project/src/format.ts","probability":0.65},{"path":"/work/project/src/parse.ts","probability":0.05}]}; 0.7 → {"ranked":[{"path":"/work/project/src/format.ts","probability":0.7},{"path":"/work/project/src/parse.ts","probability":0.05}]}; 0.75 → {"ranked":[{"path":"/work/project/src/format.ts","probability":0.75},{"path":"/work/project/src/parse.ts","probability":0.05}]}; 0.8 → {"ranked":[{"path":"/work/project/src/format.ts","probability":0.8},{"path":"/work/project/src/parse.ts","probability":0.05}]}; 0.85 → {"ranked":[{"path":"/work/project/src/format.ts","probability":0.85},{"path":"/work/project/src/parse.ts","probability":0.05}]}; 0.9 → {"ranked":[{"path":"/work/project/src/format.ts","probability":0.9},{"path":"/work/project/src/parse.ts","probability":0.05}]}; 0.95 → {"ranked":[{"path":"/work/project/src/format.ts","probability":0.95},{"path":"/work/project/src/parse.ts","probability":0.05}]}; 0.99 → {"ranked":[{"path":"/work/project/src/format.ts","probability":0.99},{"path":"/work/project/src/parse.ts","probability":0.05}]}
- no answer: {"ranked":[{"path":"/work/project/src/parse.ts","probability":0.5},{"path":"/work/project/src/format.ts","probability":0.5}]}
- the judge failed: {"ranked":[{"path":"/work/project/src/parse.ts","probability":0.5},{"path":"/work/project/src/format.ts","probability":0.5}]} (fallback)

## goal.met v1

- `achieved` (boolean), the others high:
  - p(true): 0.01–0.99 → "ask"
- `achieved` (boolean), the others low:
  - p(true): 0.01–0.75 → "continue"; 0.8–0.99 → "met"
- `needs_user` (boolean), the others high:
  - p(true): 0.01–0.75 → "met"; 0.8–0.99 → "ask"
- `needs_user` (boolean), the others low:
  - p(true): 0.01–0.75 → "continue"; 0.8–0.99 → "ask"
- no answer: "unjudged" (fallback)
- the judge failed: "unjudged" (fallback)

## hive.deliver v3

- `useful` (boolean):
  - p(true): 0.01 → {"deliver":false,"score":0.01}; 0.1 → {"deliver":false,"score":0.1}; 0.2 → {"deliver":false,"score":0.2}; 0.3 → {"deliver":true,"score":0.3}; 0.4 → {"deliver":true,"score":0.4}; 0.5 → {"deliver":true,"score":0.5}; 0.55 → {"deliver":true,"score":0.55}; 0.6 → {"deliver":true,"score":0.6}; 0.65 → {"deliver":true,"score":0.65}; 0.7 → {"deliver":true,"score":0.7}; 0.75 → {"deliver":true,"score":0.75}; 0.8 → {"deliver":true,"score":0.8}; 0.85 → {"deliver":true,"score":0.85}; 0.9 → {"deliver":true,"score":0.9}; 0.95 → {"deliver":true,"score":0.95}; 0.99 → {"deliver":true,"score":0.99}
- no answer: {"deliver":true,"score":0} (fallback)
- the judge failed: {"deliver":true,"score":0} (fallback)

## hive.publish v1

- `share_worthy` (boolean), the others high:
  - p(true): 0.01 → {"publish":false,"kind":"finding","score":0.01}; 0.1 → {"publish":false,"kind":"finding","score":0.1}; 0.2 → {"publish":false,"kind":"finding","score":0.2}; 0.3 → {"publish":false,"kind":"finding","score":0.3}; 0.4 → {"publish":false,"kind":"finding","score":0.4}; 0.5 → {"publish":false,"kind":"finding","score":0.5}; 0.55 → {"publish":false,"kind":"finding","score":0.55}; 0.6 → {"publish":false,"kind":"finding","score":0.6}; 0.65 → {"publish":false,"kind":"finding","score":0.65}; 0.7 → {"publish":false,"kind":"finding","score":0.7}; 0.75 → {"publish":false,"kind":"finding","score":0.75}; 0.8 → {"publish":true,"kind":"finding","score":0.8}; 0.85 → {"publish":true,"kind":"finding","score":0.85}; 0.9 → {"publish":true,"kind":"finding","score":0.9}; 0.95 → {"publish":true,"kind":"finding","score":0.95}; 0.99 → {"publish":true,"kind":"finding","score":0.99}
- `share_worthy` (boolean), the others low:
  - p(true): 0.01 → {"publish":false,"kind":null,"score":0.01}; 0.1 → {"publish":false,"kind":null,"score":0.1}; 0.2 → {"publish":false,"kind":null,"score":0.2}; 0.3 → {"publish":false,"kind":null,"score":0.3}; 0.4 → {"publish":false,"kind":null,"score":0.4}; 0.5 → {"publish":false,"kind":null,"score":0.5}; 0.55 → {"publish":false,"kind":null,"score":0.55}; 0.6 → {"publish":false,"kind":null,"score":0.6}; 0.65 → {"publish":false,"kind":null,"score":0.65}; 0.7 → {"publish":false,"kind":null,"score":0.7}; 0.75 → {"publish":false,"kind":null,"score":0.75}; 0.8 → {"publish":false,"kind":null,"score":0.8}; 0.85 → {"publish":false,"kind":null,"score":0.85}; 0.9 → {"publish":false,"kind":null,"score":0.9}; 0.95 → {"publish":false,"kind":null,"score":0.95}; 0.99 → {"publish":false,"kind":null,"score":0.99}
- `kind` (choice), the others high:
  - finding: 0.3–0.99 → {"publish":true,"kind":"finding","score":0.95}; without p → {"publish":true,"kind":"finding","score":0.95}
  - dead_end: 0.3–0.99 → {"publish":true,"kind":"dead_end","score":0.95}; without p → {"publish":true,"kind":"dead_end","score":0.95}
  - decision: 0.3–0.99 → {"publish":true,"kind":"decision","score":0.95}; without p → {"publish":true,"kind":"decision","score":0.95}
  - blocker: 0.3–0.99 → {"publish":true,"kind":"blocker","score":0.95}; without p → {"publish":true,"kind":"blocker","score":0.95}
  - other: 0.3–0.99 → {"publish":false,"kind":null,"score":0.95}; without p → {"publish":false,"kind":null,"score":0.95}
- `kind` (choice), the others low:
  - finding: 0.3–0.99 → {"publish":false,"kind":"finding","score":0.05}; without p → {"publish":false,"kind":"finding","score":0.05}
  - dead_end: 0.3–0.99 → {"publish":false,"kind":"dead_end","score":0.05}; without p → {"publish":false,"kind":"dead_end","score":0.05}
  - decision: 0.3–0.99 → {"publish":false,"kind":"decision","score":0.05}; without p → {"publish":false,"kind":"decision","score":0.05}
  - blocker: 0.3–0.99 → {"publish":false,"kind":"blocker","score":0.05}; without p → {"publish":false,"kind":"blocker","score":0.05}
  - other: 0.3–0.99 → {"publish":false,"kind":null,"score":0.05}; without p → {"publish":false,"kind":null,"score":0.05}
- no answer: {"publish":false,"kind":null,"score":0} (fallback)
- the judge failed: {"publish":false,"kind":null,"score":0} (fallback)

## hive.relate v2

- `relation` (choice):
  - supersedes: 0.3 → {"relation":null,"score":0.3}; 0.4 → {"relation":null,"score":0.4}; 0.5 → {"relation":null,"score":0.5}; 0.55 → {"relation":null,"score":0.55}; 0.6 → {"relation":null,"score":0.6}; 0.65 → {"relation":null,"score":0.65}; 0.7 → {"relation":null,"score":0.7}; 0.75 → {"relation":null,"score":0.75}; 0.8 → {"relation":null,"score":0.8}; 0.85 → {"relation":null,"score":0.85}; 0.9 → {"relation":"supersedes","score":0.9}; 0.95 → {"relation":"supersedes","score":0.95}; 0.99 → {"relation":"supersedes","score":0.99}; without p → {"relation":"supersedes","score":1}
  - contradicts: 0.3 → {"relation":null,"score":0.3}; 0.4 → {"relation":null,"score":0.4}; 0.5 → {"relation":null,"score":0.5}; 0.55 → {"relation":null,"score":0.55}; 0.6 → {"relation":"contradicts","score":0.6}; 0.65 → {"relation":"contradicts","score":0.65}; 0.7 → {"relation":"contradicts","score":0.7}; 0.75 → {"relation":"contradicts","score":0.75}; 0.8 → {"relation":"contradicts","score":0.8}; 0.85 → {"relation":"contradicts","score":0.85}; 0.9 → {"relation":"contradicts","score":0.9}; 0.95 → {"relation":"contradicts","score":0.95}; 0.99 → {"relation":"contradicts","score":0.99}; without p → {"relation":"contradicts","score":1}
  - supports: 0.3 → {"relation":null,"score":0.3}; 0.4 → {"relation":null,"score":0.4}; 0.5 → {"relation":null,"score":0.5}; 0.55 → {"relation":null,"score":0.55}; 0.6 → {"relation":"supports","score":0.6}; 0.65 → {"relation":"supports","score":0.65}; 0.7 → {"relation":"supports","score":0.7}; 0.75 → {"relation":"supports","score":0.75}; 0.8 → {"relation":"supports","score":0.8}; 0.85 → {"relation":"supports","score":0.85}; 0.9 → {"relation":"supports","score":0.9}; 0.95 → {"relation":"supports","score":0.95}; 0.99 → {"relation":"supports","score":0.99}; without p → {"relation":"supports","score":1}
  - none: 0.3 → {"relation":null,"score":0.3}; 0.4 → {"relation":null,"score":0.4}; 0.5 → {"relation":null,"score":0.5}; 0.55 → {"relation":null,"score":0.55}; 0.6 → {"relation":null,"score":0.6}; 0.65 → {"relation":null,"score":0.65}; 0.7 → {"relation":null,"score":0.7}; 0.75 → {"relation":null,"score":0.75}; 0.8 → {"relation":null,"score":0.8}; 0.85 → {"relation":null,"score":0.85}; 0.9 → {"relation":null,"score":0.9}; 0.95 → {"relation":null,"score":0.95}; 0.99 → {"relation":null,"score":0.99}; without p → {"relation":null,"score":1}
- no answer: {"relation":null,"score":0} (fallback)
- the judge failed: {"relation":null,"score":0} (fallback)

## input.interjection v1

- `kind` (choice):
  - correction: 0.3–0.65 → "keep"; 0.7–0.99 → "steer"; without p → "steer"
  - addition: 0.3–0.65 → "keep"; 0.7–0.99 → "followUp"; without p → "followUp"
  - side_question: 0.3–0.65 → "keep"; 0.7–0.99 → "followUp"; without p → "followUp"
  - other: 0.3–0.99 → "keep"; without p → "keep"
- no answer: "keep" (fallback)
- the judge failed: "keep" (fallback)

## input.preflight v4

- `turn_type` (choice), the others high:
  - chat: 0.3–0.55 → {"turnType":"unknown","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":3}}; 0.6–0.99 → {"turnType":"chat","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":3}}; without p → {"turnType":"chat","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":3}}
  - chat_question: 0.3–0.55 → {"turnType":"unknown","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":3}}; 0.6–0.99 → {"turnType":"chat_question","gear":"heavy","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":3}}; without p → {"turnType":"chat_question","gear":"heavy","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":3}}
  - quick_lookup: 0.3–0.55 → {"turnType":"unknown","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":3}}; 0.6–0.99 → {"turnType":"quick_lookup","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":3}}; without p → {"turnType":"quick_lookup","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":3}}
  - single_edit: 0.3–0.55 → {"turnType":"unknown","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":3}}; 0.6–0.99 → {"turnType":"single_edit","gear":"heavy","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":3}}; without p → {"turnType":"single_edit","gear":"heavy","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":3}}
  - multi_step_task: 0.3–0.55 → {"turnType":"unknown","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":3}}; 0.6–0.99 → {"turnType":"multi_step_task","gear":"heavy","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":3}}; without p → {"turnType":"multi_step_task","gear":"heavy","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":3}}
  - research: 0.3–0.55 → {"turnType":"unknown","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":3}}; 0.6–0.99 → {"turnType":"research","gear":"heavy","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":3}}; without p → {"turnType":"research","gear":"heavy","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":3}}
  - design_discussion: 0.3–0.55 → {"turnType":"unknown","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":3}}; 0.6–0.99 → {"turnType":"design_discussion","gear":"heavy","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":3}}; without p → {"turnType":"design_discussion","gear":"heavy","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":3}}
  - other: 0.3–0.99 → {"turnType":"unknown","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":3}}; without p → {"turnType":"unknown","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":3}}
- `turn_type` (choice), the others low:
  - chat: 0.3–0.55 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0}}; 0.6–0.99 → {"turnType":"chat","gear":"chat","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0}}; without p → {"turnType":"chat","gear":"chat","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0}}
  - chat_question: 0.3–0.55 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0}}; 0.6–0.99 → {"turnType":"chat_question","gear":"chat","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0}}; without p → {"turnType":"chat_question","gear":"chat","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0}}
  - quick_lookup: 0.3–0.55 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0}}; 0.6–0.99 → {"turnType":"quick_lookup","gear":"light","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0}}; without p → {"turnType":"quick_lookup","gear":"light","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0}}
  - single_edit: 0.3–0.55 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0}}; 0.6–0.99 → {"turnType":"single_edit","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0}}; without p → {"turnType":"single_edit","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0}}
  - multi_step_task: 0.3–0.55 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0}}; 0.6–0.99 → {"turnType":"multi_step_task","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0}}; without p → {"turnType":"multi_step_task","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0}}
  - research: 0.3–0.55 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0}}; 0.6–0.99 → {"turnType":"research","gear":"heavy","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0}}; without p → {"turnType":"research","gear":"heavy","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0}}
  - design_discussion: 0.3–0.55 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0}}; 0.6–0.99 → {"turnType":"design_discussion","gear":"chat","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0}}; without p → {"turnType":"design_discussion","gear":"chat","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0}}
  - other: 0.3–0.99 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0}}; without p → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0}}
- `is_side_question` (boolean), the others high:
  - p(true): 0.01–0.2 → {"turnType":"chat","gear":"standard","sideQuestion":"no","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":3}}; 0.3–0.75 → {"turnType":"chat","gear":"standard","sideQuestion":"unsure","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":3}}; 0.8–0.99 → {"turnType":"chat","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":3}}
- `is_side_question` (boolean), the others low:
  - p(true): 0.01–0.2 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0}}; 0.3–0.75 → {"turnType":"unknown","gear":"standard","sideQuestion":"unsure","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0}}; 0.8–0.99 → {"turnType":"unknown","gear":"standard","sideQuestion":"yes","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0}}
- `needs_clarification` (boolean), the others high:
  - p(true): 0.01–0.2 → {"turnType":"chat","gear":"standard","sideQuestion":"yes","needsClarification":"no","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":3}}; 0.3–0.75 → {"turnType":"chat","gear":"standard","sideQuestion":"yes","needsClarification":"unsure","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":3}}; 0.8–0.99 → {"turnType":"chat","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":3}}
- `needs_clarification` (boolean), the others low:
  - p(true): 0.01–0.2 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0}}; 0.3–0.75 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"unsure","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0}}; 0.8–0.99 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"yes","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0}}
- `needs_files_changed` (boolean), the others high:
  - p(true): 0.01–0.2 → {"turnType":"chat","gear":"chat","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"no","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":3}}; 0.3–0.75 → {"turnType":"chat","gear":"chat","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"unsure","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":3}}; 0.8–0.99 → {"turnType":"chat","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":3}}
- `needs_files_changed` (boolean), the others low:
  - p(true): 0.01–0.2 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0}}; 0.3–0.75 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"unsure","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0}}; 0.8–0.99 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"yes","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0}}
- `needs_memory` (boolean), the others high:
  - p(true): 0.01–0.2 → {"turnType":"chat","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"no","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":3}}; 0.3–0.75 → {"turnType":"chat","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"unsure","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":3}}; 0.8–0.99 → {"turnType":"chat","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":3}}
- `needs_memory` (boolean), the others low:
  - p(true): 0.01–0.2 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0}}; 0.3–0.75 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"unsure","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0}}; 0.8–0.99 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"yes","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0}}
- `swarm_worthy` (boolean), the others high:
  - p(true): 0.01–0.2 → {"turnType":"chat","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"no","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":3}}; 0.3–0.75 → {"turnType":"chat","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"unsure","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":3}}; 0.8–0.99 → {"turnType":"chat","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":3}}
- `swarm_worthy` (boolean), the others low:
  - p(true): 0.01–0.2 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0}}; 0.3–0.75 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"unsure","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0}}; 0.8–0.99 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"yes","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0}}
- `plan_first` (boolean), the others high:
  - p(true): 0.01–0.2 → {"turnType":"chat","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"no","complexity":{"task":3,"reasoning":3,"tools":3}}; 0.3–0.75 → {"turnType":"chat","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"unsure","complexity":{"task":3,"reasoning":3,"tools":3}}; 0.8–0.99 → {"turnType":"chat","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":3}}
- `plan_first` (boolean), the others low:
  - p(true): 0.01–0.2 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0}}; 0.3–0.75 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"unsure","complexity":{"task":0,"reasoning":0,"tools":0}}; 0.8–0.99 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"yes","complexity":{"task":0,"reasoning":0,"tools":0}}
- `task_complexity` (score), the others high:
  - score: 0 → {"turnType":"chat","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":0,"reasoning":3,"tools":3}}; 0.5 → {"turnType":"chat","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":0.5,"reasoning":3,"tools":3}}; 1 → {"turnType":"chat","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":1,"reasoning":3,"tools":3}}; 1.5 → {"turnType":"chat","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":1.5,"reasoning":3,"tools":3}}; 2 → {"turnType":"chat","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":2,"reasoning":3,"tools":3}}; 2.5 → {"turnType":"chat","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":2.5,"reasoning":3,"tools":3}}; 3 → {"turnType":"chat","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":3}}
- `task_complexity` (score), the others low:
  - score: 0 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0}}; 0.5 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0.5,"reasoning":0,"tools":0}}; 1 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":1,"reasoning":0,"tools":0}}; 1.5 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":1.5,"reasoning":0,"tools":0}}; 2 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":2,"reasoning":0,"tools":0}}; 2.5 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":2.5,"reasoning":0,"tools":0}}; 3 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":3,"reasoning":0,"tools":0}}
- `reasoning_depth` (score), the others high:
  - score: 0 → {"turnType":"chat","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":0,"tools":3}}; 0.5 → {"turnType":"chat","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":0.5,"tools":3}}; 1 → {"turnType":"chat","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":1,"tools":3}}; 1.5 → {"turnType":"chat","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":1.5,"tools":3}}; 2 → {"turnType":"chat","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":2,"tools":3}}; 2.5 → {"turnType":"chat","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":2.5,"tools":3}}; 3 → {"turnType":"chat","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":3}}
- `reasoning_depth` (score), the others low:
  - score: 0 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0}}; 0.5 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0.5,"tools":0}}; 1 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":1,"tools":0}}; 1.5 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":1.5,"tools":0}}; 2 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":2,"tools":0}}; 2.5 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":2.5,"tools":0}}; 3 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":3,"tools":0}}
- `tool_complexity` (score), the others high:
  - score: 0 → {"turnType":"chat","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":0}}; 0.5 → {"turnType":"chat","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":0.5}}; 1 → {"turnType":"chat","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":1}}; 1.5 → {"turnType":"chat","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":1.5}}; 2 → {"turnType":"chat","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":2}}; 2.5 → {"turnType":"chat","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":2.5}}; 3 → {"turnType":"chat","gear":"standard","sideQuestion":"yes","needsClarification":"yes","needsFilesChanged":"yes","needsMemory":"yes","swarmWorthy":"yes","planFirst":"yes","complexity":{"task":3,"reasoning":3,"tools":3}}
- `tool_complexity` (score), the others low:
  - score: 0 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0}}; 0.5 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":0.5}}; 1 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":1}}; 1.5 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":1.5}}; 2 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":2}}; 2.5 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":2.5}}; 3 → {"turnType":"unknown","gear":"standard","sideQuestion":"no","needsClarification":"no","needsFilesChanged":"no","needsMemory":"no","swarmWorthy":"no","planFirst":"no","complexity":{"task":0,"reasoning":0,"tools":3}}
- no answer: {"turnType":"unknown","gear":"standard","sideQuestion":"unsure","needsClarification":"unsure","needsFilesChanged":"unsure","needsMemory":"unsure","swarmWorthy":"unsure","planFirst":"unsure","complexity":{"task":1.5,"reasoning":1.5,"tools":1.5}} (fallback)
- the judge failed: {"turnType":"unknown","gear":"standard","sideQuestion":"unsure","needsClarification":"unsure","needsFilesChanged":"unsure","needsMemory":"unsure","swarmWorthy":"unsure","planFirst":"unsure","complexity":{"task":1.5,"reasoning":1.5,"tools":1.5}} (fallback)

## judge.items v1

- `q1` (boolean), the others high:
  - p(true): 0.01 → [0.01,0.95]; 0.1 → [0.1,0.95]; 0.2 → [0.2,0.95]; 0.3 → [0.3,0.95]; 0.4 → [0.4,0.95]; 0.5 → [0.5,0.95]; 0.55 → [0.55,0.95]; 0.6 → [0.6,0.95]; 0.65 → [0.65,0.95]; 0.7 → [0.7,0.95]; 0.75 → [0.75,0.95]; 0.8 → [0.8,0.95]; 0.85 → [0.85,0.95]; 0.9 → [0.9,0.95]; 0.95 → [0.95,0.95]; 0.99 → [0.99,0.95]
- `q1` (boolean), the others low:
  - p(true): 0.01 → [0.01,0.05]; 0.1 → [0.1,0.05]; 0.2 → [0.2,0.05]; 0.3 → [0.3,0.05]; 0.4 → [0.4,0.05]; 0.5 → [0.5,0.05]; 0.55 → [0.55,0.05]; 0.6 → [0.6,0.05]; 0.65 → [0.65,0.05]; 0.7 → [0.7,0.05]; 0.75 → [0.75,0.05]; 0.8 → [0.8,0.05]; 0.85 → [0.85,0.05]; 0.9 → [0.9,0.05]; 0.95 → [0.95,0.05]; 0.99 → [0.99,0.05]
- `q2` (boolean), the others high:
  - p(true): 0.01 → [0.95,0.01]; 0.1 → [0.95,0.1]; 0.2 → [0.95,0.2]; 0.3 → [0.95,0.3]; 0.4 → [0.95,0.4]; 0.5 → [0.95,0.5]; 0.55 → [0.95,0.55]; 0.6 → [0.95,0.6]; 0.65 → [0.95,0.65]; 0.7 → [0.95,0.7]; 0.75 → [0.95,0.75]; 0.8 → [0.95,0.8]; 0.85 → [0.95,0.85]; 0.9 → [0.95,0.9]; 0.95 → [0.95,0.95]; 0.99 → [0.95,0.99]
- `q2` (boolean), the others low:
  - p(true): 0.01 → [0.05,0.01]; 0.1 → [0.05,0.1]; 0.2 → [0.05,0.2]; 0.3 → [0.05,0.3]; 0.4 → [0.05,0.4]; 0.5 → [0.05,0.5]; 0.55 → [0.05,0.55]; 0.6 → [0.05,0.6]; 0.65 → [0.05,0.65]; 0.7 → [0.05,0.7]; 0.75 → [0.05,0.75]; 0.8 → [0.05,0.8]; 0.85 → [0.05,0.85]; 0.9 → [0.05,0.9]; 0.95 → [0.05,0.95]; 0.99 → [0.05,0.99]
- no answer: [null,null]
- the judge failed: [null,null] (fallback)

## memory.applied v1

- `applied_1` (boolean), the others high:
  - p(true): 0.01–0.2 → {"applied":["l2"],"notApplied":["l1"]}; 0.3–0.75 → {"applied":["l2"],"notApplied":[]}; 0.8–0.99 → {"applied":["l1","l2"],"notApplied":[]}
- `applied_1` (boolean), the others low:
  - p(true): 0.01–0.2 → {"applied":[],"notApplied":["l1","l2"]}; 0.3–0.75 → {"applied":[],"notApplied":["l2"]}; 0.8–0.99 → {"applied":["l1"],"notApplied":["l2"]}
- `applied_2` (boolean), the others high:
  - p(true): 0.01–0.2 → {"applied":["l1"],"notApplied":["l2"]}; 0.3–0.75 → {"applied":["l1"],"notApplied":[]}; 0.8–0.99 → {"applied":["l1","l2"],"notApplied":[]}
- `applied_2` (boolean), the others low:
  - p(true): 0.01–0.2 → {"applied":[],"notApplied":["l1","l2"]}; 0.3–0.75 → {"applied":[],"notApplied":["l1"]}; 0.8–0.99 → {"applied":["l2"],"notApplied":["l1"]}
- no answer: {"applied":[],"notApplied":[]}
- the judge failed: {"applied":[],"notApplied":[]} (fallback)

## memory.capture v2

- `correction` (boolean), the others high:
  - p(true): 0.01–0.75 → "preference"; 0.8–0.99 → "correction"
- `correction` (boolean), the others low:
  - p(true): 0.01–0.75 → "skip"; 0.8–0.99 → "correction"
- `preference` (boolean), the others high:
  - p(true): 0.01–0.99 → "correction"
- `preference` (boolean), the others low:
  - p(true): 0.01–0.75 → "skip"; 0.8–0.99 → "preference"
- no answer: "skip" (fallback)
- the judge failed: "skip" (fallback)

## memory.merge v1

- `merge_1` (choice), the others high:
  - same: 0.3–0.55 → ["unrelated","same"]; 0.6–0.99 → ["same","same"]; without p → ["same","same"]
  - refines: 0.3–0.55 → ["unrelated","same"]; 0.6–0.99 → ["refines","same"]; without p → ["refines","same"]
  - contradicts: 0.3–0.55 → ["unrelated","same"]; 0.6–0.99 → ["contradicts","same"]; without p → ["contradicts","same"]
  - unrelated: 0.3–0.99 → ["unrelated","same"]; without p → ["unrelated","same"]
  - unclear: 0.3–0.99 → ["unrelated","same"]; without p → ["unrelated","same"]
- `merge_1` (choice), the others low:
  - same: 0.3–0.55 → ["unrelated","unrelated"]; 0.6–0.99 → ["same","unrelated"]; without p → ["same","unrelated"]
  - refines: 0.3–0.55 → ["unrelated","unrelated"]; 0.6–0.99 → ["refines","unrelated"]; without p → ["refines","unrelated"]
  - contradicts: 0.3–0.55 → ["unrelated","unrelated"]; 0.6–0.99 → ["contradicts","unrelated"]; without p → ["contradicts","unrelated"]
  - unrelated: 0.3–0.99 → ["unrelated","unrelated"]; without p → ["unrelated","unrelated"]
  - unclear: 0.3–0.99 → ["unrelated","unrelated"]; without p → ["unrelated","unrelated"]
- `merge_2` (choice), the others high:
  - same: 0.3–0.55 → ["same","unrelated"]; 0.6–0.99 → ["same","same"]; without p → ["same","same"]
  - refines: 0.3–0.55 → ["same","unrelated"]; 0.6–0.99 → ["same","refines"]; without p → ["same","refines"]
  - contradicts: 0.3–0.55 → ["same","unrelated"]; 0.6–0.99 → ["same","contradicts"]; without p → ["same","contradicts"]
  - unrelated: 0.3–0.99 → ["same","unrelated"]; without p → ["same","unrelated"]
  - unclear: 0.3–0.99 → ["same","unrelated"]; without p → ["same","unrelated"]
- `merge_2` (choice), the others low:
  - same: 0.3–0.55 → ["unrelated","unrelated"]; 0.6–0.99 → ["unrelated","same"]; without p → ["unrelated","same"]
  - refines: 0.3–0.55 → ["unrelated","unrelated"]; 0.6–0.99 → ["unrelated","refines"]; without p → ["unrelated","refines"]
  - contradicts: 0.3–0.55 → ["unrelated","unrelated"]; 0.6–0.99 → ["unrelated","contradicts"]; without p → ["unrelated","contradicts"]
  - unrelated: 0.3–0.99 → ["unrelated","unrelated"]; without p → ["unrelated","unrelated"]
  - unclear: 0.3–0.99 → ["unrelated","unrelated"]; without p → ["unrelated","unrelated"]
- no answer: ["unrelated","unrelated"]
- the judge failed: ["unrelated","unrelated"] (fallback)

## memory.outcome v1

- `way_out` (boolean):
  - p(true): 0.01–0.75 → "skip"; 0.8–0.99 → "learn"
- no answer: "skip" (fallback)
- the judge failed: "skip" (fallback)

## memory.recall v1

- `lesson_0` (boolean), the others high:
  - p(true): 0.01–0.75 → {"apply":["l3"]}; 0.8–0.99 → {"apply":["l1","l3"]}
- `lesson_0` (boolean), the others low:
  - p(true): 0.01–0.75 → {"apply":[]}; 0.8–0.99 → {"apply":["l1"]}
- `lesson_1` (boolean), the others high:
  - p(true): 0.01–0.75 → {"apply":["l1"]}; 0.8–0.99 → {"apply":["l1","l3"]}
- `lesson_1` (boolean), the others low:
  - p(true): 0.01–0.75 → {"apply":[]}; 0.8–0.99 → {"apply":["l3"]}
- no answer: {"apply":[]}
- the judge failed: {"apply":[]} (fallback)

## memory.recall v2

- `lesson_0` (boolean), the others high:
  - p(true): 0.01–0.75 → {"apply":["l2"]}; 0.8–0.99 → {"apply":["l1","l2"]}
- `lesson_0` (boolean), the others low:
  - p(true): 0.01–0.75 → {"apply":[]}; 0.8–0.99 → {"apply":["l1"]}
- `lesson_1` (boolean), the others high:
  - p(true): 0.01–0.75 → {"apply":["l1"]}; 0.8–0.99 → {"apply":["l1","l2"]}
- `lesson_1` (boolean), the others low:
  - p(true): 0.01–0.75 → {"apply":[]}; 0.8–0.99 → {"apply":["l2"]}
- no answer: {"apply":[]}
- the judge failed: {"apply":[]} (fallback)

## memory.worth v1

- `worth_1` (choice), the others high:
  - reusable: 0.3–0.55 → ["unclear","reusable"]; 0.6–0.99 → ["reusable","reusable"]; without p → ["reusable","reusable"]
  - one_off: 0.3–0.55 → ["unclear","reusable"]; 0.6–0.99 → ["one_off","reusable"]; without p → ["one_off","reusable"]
  - already_known: 0.3–0.55 → ["unclear","reusable"]; 0.6–0.99 → ["already_known","reusable"]; without p → ["already_known","reusable"]
  - unclear: 0.3–0.99 → ["unclear","reusable"]; without p → ["unclear","reusable"]
- `worth_1` (choice), the others low:
  - reusable: 0.3–0.55 → ["unclear","unclear"]; 0.6–0.99 → ["reusable","unclear"]; without p → ["reusable","unclear"]
  - one_off: 0.3–0.55 → ["unclear","unclear"]; 0.6–0.99 → ["one_off","unclear"]; without p → ["one_off","unclear"]
  - already_known: 0.3–0.55 → ["unclear","unclear"]; 0.6–0.99 → ["already_known","unclear"]; without p → ["already_known","unclear"]
  - unclear: 0.3–0.99 → ["unclear","unclear"]; without p → ["unclear","unclear"]
- `worth_2` (choice), the others high:
  - reusable: 0.3–0.55 → ["reusable","unclear"]; 0.6–0.99 → ["reusable","reusable"]; without p → ["reusable","reusable"]
  - one_off: 0.3–0.55 → ["reusable","unclear"]; 0.6–0.99 → ["reusable","one_off"]; without p → ["reusable","one_off"]
  - already_known: 0.3–0.55 → ["reusable","unclear"]; 0.6–0.99 → ["reusable","already_known"]; without p → ["reusable","already_known"]
  - unclear: 0.3–0.99 → ["reusable","unclear"]; without p → ["reusable","unclear"]
- `worth_2` (choice), the others low:
  - reusable: 0.3–0.55 → ["unclear","unclear"]; 0.6–0.99 → ["unclear","reusable"]; without p → ["unclear","reusable"]
  - one_off: 0.3–0.55 → ["unclear","unclear"]; 0.6–0.99 → ["unclear","one_off"]; without p → ["unclear","one_off"]
  - already_known: 0.3–0.55 → ["unclear","unclear"]; 0.6–0.99 → ["unclear","already_known"]; without p → ["unclear","already_known"]
  - unclear: 0.3–0.99 → ["unclear","unclear"]; without p → ["unclear","unclear"]
- no answer: ["unclear","unclear"]
- the judge failed: ["unclear","unclear"] (fallback)

## notify.routing v1

- `urgency` (choice):
  - now: 0.3–0.55 → "next_turn"; 0.6–0.99 → "now"; without p → "now"
  - next_turn: 0.3–0.99 → "next_turn"; without p → "next_turn"
  - drop: 0.3–0.55 → "next_turn"; 0.6–0.99 → "drop"; without p → "drop"
  - other: 0.3–0.99 → "next_turn"; without p → "next_turn"
- no answer: "next_turn" (fallback)
- the judge failed: "next_turn" (fallback)

## output.drift v1

- `rule_0` (boolean), the others high:
  - p(true): 0.01–0.75 → {"broken":[1]}; 0.8–0.99 → {"broken":[0,1]}
- `rule_0` (boolean), the others low:
  - p(true): 0.01–0.75 → {"broken":[]}; 0.8–0.99 → {"broken":[0]}
- `rule_1` (boolean), the others high:
  - p(true): 0.01–0.75 → {"broken":[0]}; 0.8–0.99 → {"broken":[0,1]}
- `rule_1` (boolean), the others low:
  - p(true): 0.01–0.75 → {"broken":[]}; 0.8–0.99 → {"broken":[1]}
- no answer: {"broken":[]}
- the judge failed: {"broken":[]} (fallback)

## review.triage v1

- `is_bug_0` (boolean), the others high:
  - p(true): 0.01–0.2 → {"priorities":["P2","P1"]}; 0.3–0.75 → {"priorities":["P1","P1"]}; 0.8–0.99 → {"priorities":["P0","P1"]}
- `is_bug_0` (boolean), the others low:
  - p(true): 0.01–0.2 → {"priorities":["P2","P3"]}; 0.3–0.75 → {"priorities":["P1","P3"]}; 0.8–0.99 → {"priorities":["P2","P3"]}
- `in_scope_0` (boolean), the others high:
  - p(true): 0.01–0.2 → {"priorities":["P2","P1"]}; 0.3–0.75 → {"priorities":["P1","P1"]}; 0.8–0.99 → {"priorities":["P0","P1"]}
- `in_scope_0` (boolean), the others low:
  - p(true): 0.01–0.99 → {"priorities":["P2","P3"]}
- `is_bug_1` (boolean), the others high:
  - p(true): 0.01–0.2 → {"priorities":["P0","P3"]}; 0.3–0.75 → {"priorities":["P0","P2"]}; 0.8–0.99 → {"priorities":["P0","P1"]}
- `is_bug_1` (boolean), the others low:
  - p(true): 0.01–0.2 → {"priorities":["P2","P3"]}; 0.3–0.99 → {"priorities":["P2","P2"]}
- `in_scope_1` (boolean), the others high:
  - p(true): 0.01–0.2 → {"priorities":["P0","P2"]}; 0.3–0.99 → {"priorities":["P0","P1"]}
- `in_scope_1` (boolean), the others low:
  - p(true): 0.01–0.99 → {"priorities":["P2","P3"]}
- no answer: {"priorities":["P1","P2"]}
- the judge failed: {"priorities":["P1","P3"]} (fallback)

## skill.capture v1

- `kind` (choice):
  - procedure: 0.3–0.85 → "skip"; 0.9–0.99 → "draft"; without p → "draft"
  - one_off: 0.3–0.99 → "skip"; without p → "skip"
  - covered: 0.3–0.99 → "skip"; without p → "skip"
  - unclear: 0.3–0.99 → "skip"; without p → "skip"
- no answer: "skip" (fallback)
- the judge failed: "skip" (fallback)

## skills.disclosure v1

- `skill_0` (boolean), the others high:
  - p(true): 0.01–0.2 → {"hide":["vitest"],"relevant":["release"]}; 0.3–0.75 → {"hide":[],"relevant":["release"]}; 0.8–0.99 → {"hide":[],"relevant":["vitest","release"]}
- `skill_0` (boolean), the others low:
  - p(true): 0.01–0.2 → {"hide":["vitest","release"],"relevant":[]}; 0.3–0.75 → {"hide":["release"],"relevant":[]}; 0.8–0.99 → {"hide":["release"],"relevant":["vitest"]}
- `skill_1` (boolean), the others high:
  - p(true): 0.01–0.2 → {"hide":["release"],"relevant":["vitest"]}; 0.3–0.75 → {"hide":[],"relevant":["vitest"]}; 0.8–0.99 → {"hide":[],"relevant":["vitest","release"]}
- `skill_1` (boolean), the others low:
  - p(true): 0.01–0.2 → {"hide":["vitest","release"],"relevant":[]}; 0.3–0.75 → {"hide":["vitest"],"relevant":[]}; 0.8–0.99 → {"hide":["vitest"],"relevant":["release"]}
- no answer: {"hide":[],"relevant":[]}
- the judge failed: {"hide":[],"relevant":[]} (fallback)

## swarm.patch v2

- `within_task` (boolean), the others high:
  - p(true): 0.01–0.2 → {"withinTask":false,"unrelated":[],"judged":2}; 0.3–0.75 → {"withinTask":null,"unrelated":[],"judged":2}; 0.8–0.99 → {"withinTask":true,"unrelated":[],"judged":2}
- `within_task` (boolean), the others low:
  - p(true): 0.01–0.2 → {"withinTask":false,"unrelated":["src/parse.ts","package-lock.json"],"judged":2}; 0.3–0.75 → {"withinTask":null,"unrelated":["src/parse.ts","package-lock.json"],"judged":2}; 0.8–0.99 → {"withinTask":true,"unrelated":["src/parse.ts","package-lock.json"],"judged":2}
- `file_0` (boolean), the others high:
  - p(true): 0.01–0.3 → {"withinTask":true,"unrelated":["src/parse.ts"],"judged":2}; 0.4–0.99 → {"withinTask":true,"unrelated":[],"judged":2}
- `file_0` (boolean), the others low:
  - p(true): 0.01–0.3 → {"withinTask":false,"unrelated":["src/parse.ts","package-lock.json"],"judged":2}; 0.4–0.99 → {"withinTask":false,"unrelated":["package-lock.json"],"judged":2}
- `file_1` (boolean), the others high:
  - p(true): 0.01–0.3 → {"withinTask":true,"unrelated":["package-lock.json"],"judged":2}; 0.4–0.99 → {"withinTask":true,"unrelated":[],"judged":2}
- `file_1` (boolean), the others low:
  - p(true): 0.01–0.3 → {"withinTask":false,"unrelated":["src/parse.ts","package-lock.json"],"judged":2}; 0.4–0.99 → {"withinTask":false,"unrelated":["src/parse.ts"],"judged":2}
- no answer: {"withinTask":null,"unrelated":[],"judged":2}
- the judge failed: {"withinTask":null,"unrelated":[],"judged":0} (fallback)

## swarm.routing v3

- `agent` (choice), the others high:
  - worker: 0.3–0.4 → {"strength":1,"thinking":"high","agent":null}; 0.5–0.99 → {"strength":1,"thinking":"high","agent":"worker"}; without p → {"strength":1,"thinking":"high","agent":"worker"}
  - scout: 0.3–0.4 → {"strength":1,"thinking":"high","agent":null}; 0.5–0.99 → {"strength":1,"thinking":"high","agent":"scout"}; without p → {"strength":1,"thinking":"high","agent":"scout"}
  - other: 0.3–0.99 → {"strength":1,"thinking":"high","agent":null}; without p → {"strength":1,"thinking":"high","agent":null}
- `agent` (choice), the others low:
  - worker: 0.3–0.4 → {"strength":0,"thinking":"low","agent":null}; 0.5–0.99 → {"strength":0,"thinking":"low","agent":"worker"}; without p → {"strength":0,"thinking":"low","agent":"worker"}
  - scout: 0.3–0.4 → {"strength":0,"thinking":"low","agent":null}; 0.5–0.99 → {"strength":0,"thinking":"low","agent":"scout"}; without p → {"strength":0,"thinking":"low","agent":"scout"}
  - other: 0.3–0.99 → {"strength":0,"thinking":"low","agent":null}; without p → {"strength":0,"thinking":"low","agent":null}
- `difficulty` (score), the others high:
  - score: 0 → {"strength":0,"thinking":"high","agent":"worker"}; 0.5 → {"strength":0.16666666666666666,"thinking":"high","agent":"worker"}; 1 → {"strength":0.3333333333333333,"thinking":"high","agent":"worker"}; 1.5 → {"strength":0.5,"thinking":"high","agent":"worker"}; 2 → {"strength":0.6666666666666666,"thinking":"high","agent":"worker"}; 2.5 → {"strength":0.8333333333333334,"thinking":"high","agent":"worker"}; 3 → {"strength":1,"thinking":"high","agent":"worker"}
- `difficulty` (score), the others low:
  - score: 0 → {"strength":0,"thinking":"low","agent":null}; 0.5 → {"strength":0.16666666666666666,"thinking":"low","agent":null}; 1 → {"strength":0.3333333333333333,"thinking":"low","agent":null}; 1.5 → {"strength":0.5,"thinking":"low","agent":null}; 2 → {"strength":0.6666666666666666,"thinking":"low","agent":null}; 2.5 → {"strength":0.8333333333333334,"thinking":"low","agent":null}; 3 → {"strength":1,"thinking":"low","agent":null}
- `reasoning` (score), the others high:
  - score: 0–1 → {"strength":1,"thinking":"low","agent":"worker"}; 1.5–2 → {"strength":1,"thinking":"medium","agent":"worker"}; 2.5–3 → {"strength":1,"thinking":"high","agent":"worker"}
- `reasoning` (score), the others low:
  - score: 0–1 → {"strength":0,"thinking":"low","agent":null}; 1.5–2 → {"strength":0,"thinking":"medium","agent":null}; 2.5–3 → {"strength":0,"thinking":"high","agent":null}
- no answer: {"strength":0.5,"thinking":"medium","agent":null}
- the judge failed: {"strength":0.5,"thinking":"medium","agent":null} (fallback)

## task.frame v1

- `change` (choice):
  - new_task: 0.3–0.55 → "none"; 0.6–0.99 → "new_task"; without p → "new_task"
  - constraint: 0.3–0.55 → "none"; 0.6–0.99 → "constraint"; without p → "constraint"
  - correction: 0.3–0.55 → "none"; 0.6–0.99 → "correction"; without p → "correction"
  - subgoal: 0.3–0.55 → "none"; 0.6–0.99 → "subgoal"; without p → "subgoal"
  - none: 0.3–0.99 → "none"; without p → "none"
- no answer: "none" (fallback)
- the judge failed: "none" (fallback)

## tool.admission v2

- `kind` (choice):
  - error: 0.3–0.55 → {"kind":"unknown","drop":false}; 0.6–0.99 → {"kind":"error","drop":false}; without p → {"kind":"error","drop":false}
  - result: 0.3–0.55 → {"kind":"unknown","drop":false}; 0.6–0.99 → {"kind":"result","drop":false}; without p → {"kind":"result","drop":false}
  - progress: 0.3–0.55 → {"kind":"unknown","drop":false}; 0.6–0.99 → {"kind":"progress","drop":true}; without p → {"kind":"progress","drop":true}
  - warning: 0.3–0.55 → {"kind":"unknown","drop":false}; 0.6–0.99 → {"kind":"warning","drop":true}; without p → {"kind":"warning","drop":true}
  - passing: 0.3–0.55 → {"kind":"unknown","drop":false}; 0.6–0.99 → {"kind":"passing","drop":true}; without p → {"kind":"passing","drop":true}
  - other: 0.3–0.99 → {"kind":"unknown","drop":false}; without p → {"kind":"unknown","drop":false}
- no answer: {"kind":"unknown","drop":false}
- the judge failed: {"kind":"unknown","drop":false} (fallback)

## tool.admission v3

- `k1` (choice), the others high:
  - error: 0.3–0.55 → [{"kind":"unknown","drop":false},{"kind":"error","drop":false}]; 0.6–0.99 → [{"kind":"error","drop":false},{"kind":"error","drop":false}]; without p → [{"kind":"error","drop":false},{"kind":"error","drop":false}]
  - result: 0.3–0.55 → [{"kind":"unknown","drop":false},{"kind":"error","drop":false}]; 0.6–0.99 → [{"kind":"result","drop":false},{"kind":"error","drop":false}]; without p → [{"kind":"result","drop":false},{"kind":"error","drop":false}]
  - progress: 0.3–0.55 → [{"kind":"unknown","drop":false},{"kind":"error","drop":false}]; 0.6–0.99 → [{"kind":"progress","drop":true},{"kind":"error","drop":false}]; without p → [{"kind":"progress","drop":true},{"kind":"error","drop":false}]
  - warning: 0.3–0.55 → [{"kind":"unknown","drop":false},{"kind":"error","drop":false}]; 0.6–0.99 → [{"kind":"warning","drop":true},{"kind":"error","drop":false}]; without p → [{"kind":"warning","drop":true},{"kind":"error","drop":false}]
  - passing: 0.3–0.55 → [{"kind":"unknown","drop":false},{"kind":"error","drop":false}]; 0.6–0.99 → [{"kind":"passing","drop":true},{"kind":"error","drop":false}]; without p → [{"kind":"passing","drop":true},{"kind":"error","drop":false}]
  - other: 0.3–0.99 → [{"kind":"unknown","drop":false},{"kind":"error","drop":false}]; without p → [{"kind":"unknown","drop":false},{"kind":"error","drop":false}]
- `k1` (choice), the others low:
  - error: 0.3–0.55 → [{"kind":"unknown","drop":false},{"kind":"unknown","drop":false}]; 0.6–0.99 → [{"kind":"error","drop":false},{"kind":"unknown","drop":false}]; without p → [{"kind":"error","drop":false},{"kind":"unknown","drop":false}]
  - result: 0.3–0.55 → [{"kind":"unknown","drop":false},{"kind":"unknown","drop":false}]; 0.6–0.99 → [{"kind":"result","drop":false},{"kind":"unknown","drop":false}]; without p → [{"kind":"result","drop":false},{"kind":"unknown","drop":false}]
  - progress: 0.3–0.55 → [{"kind":"unknown","drop":false},{"kind":"unknown","drop":false}]; 0.6–0.99 → [{"kind":"progress","drop":true},{"kind":"unknown","drop":false}]; without p → [{"kind":"progress","drop":true},{"kind":"unknown","drop":false}]
  - warning: 0.3–0.55 → [{"kind":"unknown","drop":false},{"kind":"unknown","drop":false}]; 0.6–0.99 → [{"kind":"warning","drop":true},{"kind":"unknown","drop":false}]; without p → [{"kind":"warning","drop":true},{"kind":"unknown","drop":false}]
  - passing: 0.3–0.55 → [{"kind":"unknown","drop":false},{"kind":"unknown","drop":false}]; 0.6–0.99 → [{"kind":"passing","drop":true},{"kind":"unknown","drop":false}]; without p → [{"kind":"passing","drop":true},{"kind":"unknown","drop":false}]
  - other: 0.3–0.99 → [{"kind":"unknown","drop":false},{"kind":"unknown","drop":false}]; without p → [{"kind":"unknown","drop":false},{"kind":"unknown","drop":false}]
- `k2` (choice), the others high:
  - error: 0.3–0.55 → [{"kind":"error","drop":false},{"kind":"unknown","drop":false}]; 0.6–0.99 → [{"kind":"error","drop":false},{"kind":"error","drop":false}]; without p → [{"kind":"error","drop":false},{"kind":"error","drop":false}]
  - result: 0.3–0.55 → [{"kind":"error","drop":false},{"kind":"unknown","drop":false}]; 0.6–0.99 → [{"kind":"error","drop":false},{"kind":"result","drop":false}]; without p → [{"kind":"error","drop":false},{"kind":"result","drop":false}]
  - progress: 0.3–0.55 → [{"kind":"error","drop":false},{"kind":"unknown","drop":false}]; 0.6–0.99 → [{"kind":"error","drop":false},{"kind":"progress","drop":true}]; without p → [{"kind":"error","drop":false},{"kind":"progress","drop":true}]
  - warning: 0.3–0.55 → [{"kind":"error","drop":false},{"kind":"unknown","drop":false}]; 0.6–0.99 → [{"kind":"error","drop":false},{"kind":"warning","drop":true}]; without p → [{"kind":"error","drop":false},{"kind":"warning","drop":true}]
  - passing: 0.3–0.55 → [{"kind":"error","drop":false},{"kind":"unknown","drop":false}]; 0.6–0.99 → [{"kind":"error","drop":false},{"kind":"passing","drop":true}]; without p → [{"kind":"error","drop":false},{"kind":"passing","drop":true}]
  - other: 0.3–0.99 → [{"kind":"error","drop":false},{"kind":"unknown","drop":false}]; without p → [{"kind":"error","drop":false},{"kind":"unknown","drop":false}]
- `k2` (choice), the others low:
  - error: 0.3–0.55 → [{"kind":"unknown","drop":false},{"kind":"unknown","drop":false}]; 0.6–0.99 → [{"kind":"unknown","drop":false},{"kind":"error","drop":false}]; without p → [{"kind":"unknown","drop":false},{"kind":"error","drop":false}]
  - result: 0.3–0.55 → [{"kind":"unknown","drop":false},{"kind":"unknown","drop":false}]; 0.6–0.99 → [{"kind":"unknown","drop":false},{"kind":"result","drop":false}]; without p → [{"kind":"unknown","drop":false},{"kind":"result","drop":false}]
  - progress: 0.3–0.55 → [{"kind":"unknown","drop":false},{"kind":"unknown","drop":false}]; 0.6–0.99 → [{"kind":"unknown","drop":false},{"kind":"progress","drop":true}]; without p → [{"kind":"unknown","drop":false},{"kind":"progress","drop":true}]
  - warning: 0.3–0.55 → [{"kind":"unknown","drop":false},{"kind":"unknown","drop":false}]; 0.6–0.99 → [{"kind":"unknown","drop":false},{"kind":"warning","drop":true}]; without p → [{"kind":"unknown","drop":false},{"kind":"warning","drop":true}]
  - passing: 0.3–0.55 → [{"kind":"unknown","drop":false},{"kind":"unknown","drop":false}]; 0.6–0.99 → [{"kind":"unknown","drop":false},{"kind":"passing","drop":true}]; without p → [{"kind":"unknown","drop":false},{"kind":"passing","drop":true}]
  - other: 0.3–0.99 → [{"kind":"unknown","drop":false},{"kind":"unknown","drop":false}]; without p → [{"kind":"unknown","drop":false},{"kind":"unknown","drop":false}]
- no answer: [{"kind":"unknown","drop":false},{"kind":"unknown","drop":false}]
- the judge failed: [{"kind":"unknown","drop":false},{"kind":"unknown","drop":false}] (fallback)

## tool.admission.test-log v3

- `part_1` (choice), the others high:
  - needed: 0.3–0.99 → {"omit":[]}; without p → {"omit":[]}
  - not_needed: 0.3–0.85 → {"omit":[]}; 0.9–0.99 → {"omit":["part_1"]}; without p → {"omit":[]}
  - unclear: 0.3–0.99 → {"omit":[]}; without p → {"omit":[]}
- `part_1` (choice), the others low:
  - needed: 0.3–0.99 → {"omit":[]}; without p → {"omit":[]}
  - not_needed: 0.3–0.85 → {"omit":[]}; 0.9–0.99 → {"omit":["part_1"]}; without p → {"omit":[]}
  - unclear: 0.3–0.99 → {"omit":[]}; without p → {"omit":[]}
- `part_2` (choice), the others high:
  - needed: 0.3–0.99 → {"omit":[]}; without p → {"omit":[]}
  - not_needed: 0.3–0.85 → {"omit":[]}; 0.9–0.99 → {"omit":["part_2"]}; without p → {"omit":[]}
  - unclear: 0.3–0.99 → {"omit":[]}; without p → {"omit":[]}
- `part_2` (choice), the others low:
  - needed: 0.3–0.99 → {"omit":[]}; without p → {"omit":[]}
  - not_needed: 0.3–0.85 → {"omit":[]}; 0.9–0.99 → {"omit":["part_2"]}; without p → {"omit":[]}
  - unclear: 0.3–0.99 → {"omit":[]}; without p → {"omit":[]}
- no answer: {"omit":[]}
- the judge failed: {"omit":[]} (fallback)

## tool.approval v3

- `verdict` (choice):
  - needed: 0.3–0.75 → "unsure"; 0.8–0.99 → "approve"; without p → "approve"
  - beyond: 0.3–0.99 → "beyond"; without p → "beyond"
  - unrelated: 0.3–0.99 → "unrelated"; without p → "unrelated"
  - unclear: 0.3–0.99 → "unsure"; without p → "unsure"
- no answer: "unsure" (fallback)
- the judge failed: "unsure" (fallback)

## tool.constraint v1

- `constraint_0` (boolean), the others high:
  - p(true): 0.01–0.75 → {"broken":[1]}; 0.8–0.99 → {"broken":[0,1]}
- `constraint_0` (boolean), the others low:
  - p(true): 0.01–0.75 → {"broken":[]}; 0.8–0.99 → {"broken":[0]}
- `constraint_1` (boolean), the others high:
  - p(true): 0.01–0.75 → {"broken":[0]}; 0.8–0.99 → {"broken":[0,1]}
- `constraint_1` (boolean), the others low:
  - p(true): 0.01–0.75 → {"broken":[]}; 0.8–0.99 → {"broken":[1]}
- no answer: {"broken":[]}
- the judge failed: {"broken":[]} (fallback)

## tool.description v2

- `q1` (boolean), the others high:
  - p(true): 0.01 → [0.01,0.95]; 0.1 → [0.1,0.95]; 0.2 → [0.2,0.95]; 0.3 → [0.3,0.95]; 0.4 → [0.4,0.95]; 0.5 → [0.5,0.95]; 0.55 → [0.55,0.95]; 0.6 → [0.6,0.95]; 0.65 → [0.65,0.95]; 0.7 → [0.7,0.95]; 0.75 → [0.75,0.95]; 0.8 → [0.8,0.95]; 0.85 → [0.85,0.95]; 0.9 → [0.9,0.95]; 0.95 → [0.95,0.95]; 0.99 → [0.99,0.95]
- `q1` (boolean), the others low:
  - p(true): 0.01 → [0.01,0.05]; 0.1 → [0.1,0.05]; 0.2 → [0.2,0.05]; 0.3 → [0.3,0.05]; 0.4 → [0.4,0.05]; 0.5 → [0.5,0.05]; 0.55 → [0.55,0.05]; 0.6 → [0.6,0.05]; 0.65 → [0.65,0.05]; 0.7 → [0.7,0.05]; 0.75 → [0.75,0.05]; 0.8 → [0.8,0.05]; 0.85 → [0.85,0.05]; 0.9 → [0.9,0.05]; 0.95 → [0.95,0.05]; 0.99 → [0.99,0.05]
- `q2` (boolean), the others high:
  - p(true): 0.01 → [0.95,0.01]; 0.1 → [0.95,0.1]; 0.2 → [0.95,0.2]; 0.3 → [0.95,0.3]; 0.4 → [0.95,0.4]; 0.5 → [0.95,0.5]; 0.55 → [0.95,0.55]; 0.6 → [0.95,0.6]; 0.65 → [0.95,0.65]; 0.7 → [0.95,0.7]; 0.75 → [0.95,0.75]; 0.8 → [0.95,0.8]; 0.85 → [0.95,0.85]; 0.9 → [0.95,0.9]; 0.95 → [0.95,0.95]; 0.99 → [0.95,0.99]
- `q2` (boolean), the others low:
  - p(true): 0.01 → [0.05,0.01]; 0.1 → [0.05,0.1]; 0.2 → [0.05,0.2]; 0.3 → [0.05,0.3]; 0.4 → [0.05,0.4]; 0.5 → [0.05,0.5]; 0.55 → [0.05,0.55]; 0.6 → [0.05,0.6]; 0.65 → [0.05,0.65]; 0.7 → [0.05,0.7]; 0.75 → [0.05,0.75]; 0.8 → [0.05,0.8]; 0.85 → [0.05,0.85]; 0.9 → [0.05,0.9]; 0.95 → [0.05,0.95]; 0.99 → [0.05,0.99]
- no answer: [null,null]
- the judge failed: [null,null] (fallback)

## tool.injection v1

- `injected` (boolean):
  - p(true): 0.01 → 0.01; 0.1 → 0.1; 0.2 → 0.2; 0.3 → 0.3; 0.4 → 0.4; 0.5 → 0.5; 0.55 → 0.55; 0.6 → 0.6; 0.65 → 0.65; 0.7 → 0.7; 0.75 → 0.75; 0.8 → 0.8; 0.85 → 0.85; 0.9 → 0.9; 0.95 → 0.95; 0.99 → 0.99
- no answer: null (fallback)
- the judge failed: null (fallback)

## tool.injection v1

- `i1` (boolean), the others high:
  - p(true): 0.01 → [0.01,0.95]; 0.1 → [0.1,0.95]; 0.2 → [0.2,0.95]; 0.3 → [0.3,0.95]; 0.4 → [0.4,0.95]; 0.5 → [0.5,0.95]; 0.55 → [0.55,0.95]; 0.6 → [0.6,0.95]; 0.65 → [0.65,0.95]; 0.7 → [0.7,0.95]; 0.75 → [0.75,0.95]; 0.8 → [0.8,0.95]; 0.85 → [0.85,0.95]; 0.9 → [0.9,0.95]; 0.95 → [0.95,0.95]; 0.99 → [0.99,0.95]
- `i1` (boolean), the others low:
  - p(true): 0.01 → [0.01,0.05]; 0.1 → [0.1,0.05]; 0.2 → [0.2,0.05]; 0.3 → [0.3,0.05]; 0.4 → [0.4,0.05]; 0.5 → [0.5,0.05]; 0.55 → [0.55,0.05]; 0.6 → [0.6,0.05]; 0.65 → [0.65,0.05]; 0.7 → [0.7,0.05]; 0.75 → [0.75,0.05]; 0.8 → [0.8,0.05]; 0.85 → [0.85,0.05]; 0.9 → [0.9,0.05]; 0.95 → [0.95,0.05]; 0.99 → [0.99,0.05]
- `i2` (boolean), the others high:
  - p(true): 0.01 → [0.95,0.01]; 0.1 → [0.95,0.1]; 0.2 → [0.95,0.2]; 0.3 → [0.95,0.3]; 0.4 → [0.95,0.4]; 0.5 → [0.95,0.5]; 0.55 → [0.95,0.55]; 0.6 → [0.95,0.6]; 0.65 → [0.95,0.65]; 0.7 → [0.95,0.7]; 0.75 → [0.95,0.75]; 0.8 → [0.95,0.8]; 0.85 → [0.95,0.85]; 0.9 → [0.95,0.9]; 0.95 → [0.95,0.95]; 0.99 → [0.95,0.99]
- `i2` (boolean), the others low:
  - p(true): 0.01 → [0.05,0.01]; 0.1 → [0.05,0.1]; 0.2 → [0.05,0.2]; 0.3 → [0.05,0.3]; 0.4 → [0.05,0.4]; 0.5 → [0.05,0.5]; 0.55 → [0.05,0.55]; 0.6 → [0.05,0.6]; 0.65 → [0.05,0.65]; 0.7 → [0.05,0.7]; 0.75 → [0.05,0.75]; 0.8 → [0.05,0.8]; 0.85 → [0.05,0.85]; 0.9 → [0.05,0.9]; 0.95 → [0.05,0.95]; 0.99 → [0.05,0.99]
- no answer: [null,null] (fallback)
- the judge failed: [null,null] (fallback)

## tool.risk v2

- `requested` (boolean):
  - p(true): 0.01–0.75 → "confirm"; 0.8–0.99 → "allow"
- no answer: "confirm" (fallback)
- the judge failed: "confirm" (fallback)

## turn.completion v2

- `claims_done` (boolean), the others high:
  - p(true): 0.01–0.75 → "done"; 0.8–0.99 → "nudge"
- `claims_done` (boolean), the others low:
  - p(true): 0.01–0.99 → "done"
- `needs_check` (boolean), the others high:
  - p(true): 0.01–0.75 → "done"; 0.8–0.99 → "nudge"
- `needs_check` (boolean), the others low:
  - p(true): 0.01–0.99 → "done"
- no answer: "done" (fallback)
- the judge failed: "done" (fallback)

## turn.continue v2

- `promised` (boolean), the others high:
  - p(true): 0.01–0.99 → "end"
- `promised` (boolean), the others low:
  - p(true): 0.01–0.75 → "end"; 0.8–0.99 → "promised"
- `asks_go_ahead` (boolean), the others high:
  - p(true): 0.01–0.99 → "end"
- `asks_go_ahead` (boolean), the others low:
  - p(true): 0.01–0.99 → "end"
- `work_requested` (boolean), the others high:
  - p(true): 0.01–0.99 → "end"
- `work_requested` (boolean), the others low:
  - p(true): 0.01–0.99 → "end"
- `beyond_request` (boolean), the others high:
  - p(true): 0.01–0.99 → "end"
- `beyond_request` (boolean), the others low:
  - p(true): 0.01–0.99 → "end"
- `irreversible` (boolean), the others high:
  - p(true): 0.01–0.2 → "promised"; 0.3–0.99 → "end"
- `irreversible` (boolean), the others low:
  - p(true): 0.01–0.99 → "end"
- no answer: "end" (fallback)
- the judge failed: "end" (fallback)

## turn.drift v2

- `course` (choice):
  - on_track: 0.3–0.65 → "unknown"; 0.7–0.99 → "on_track"; without p → "on_track"
  - detour: 0.3–0.65 → "unknown"; 0.7–0.99 → "detour"; without p → "detour"
  - drift: 0.3–0.85 → "unknown"; 0.9–0.99 → "drift"; without p → "drift"
  - loop: 0.3–0.75 → "unknown"; 0.8–0.99 → "loop"; without p → "loop"
  - other: 0.3–0.99 → "unknown"; without p → "unknown"
- no answer: "unknown" (fallback)
- the judge failed: "unknown" (fallback)

## turn.rewind v2

- `dead_end` (boolean), the others high:
  - p(true): 0.01–0.99 → "continue"
- `dead_end` (boolean), the others low:
  - p(true): 0.01–0.75 → "continue"; 0.8–0.99 → "propose"
- `progress` (boolean), the others high:
  - p(true): 0.01–0.4 → "propose"; 0.5–0.99 → "continue"
- `progress` (boolean), the others low:
  - p(true): 0.01–0.99 → "continue"
- no answer: "continue" (fallback)
- the judge failed: "continue" (fallback)

## tool.approval v3

- `verdict` (choice):
  - needed: 0.3–0.65 → "unsure"; 0.7–0.99 → "approve"; without p → "approve"
  - beyond: 0.3–0.99 → "beyond"; without p → "beyond"
  - unrelated: 0.3–0.99 → "unrelated"; without p → "unrelated"
  - unclear: 0.3–0.99 → "unsure"; without p → "unsure"
- no answer: "unsure" (fallback)
- the judge failed: "unsure" (fallback)
